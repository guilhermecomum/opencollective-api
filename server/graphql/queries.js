import Promise from 'bluebird';
import errors from '../lib/errors';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean
} from 'graphql';

import {
  CollectiveInterfaceType
} from './CollectiveInterface';

import {
  TransactionInterfaceType  
} from './TransactionInterface';

import {
  UserType,
  TierType,
  ExpenseType,
  InvoiceType,
  UpdateType,
  MemberType,
  PaymentMethodType
} from './types';

import { get } from 'lodash';
import models, { sequelize } from '../models';
import rawQueries from '../lib/queries';
import { fetchCollectiveId } from '../lib/cache';

const queries = {
  Collective: {
    type: CollectiveInterfaceType,
    args: {
      slug: { type: new GraphQLNonNull(GraphQLString) }
    },
    resolve(_, args) {
      return models.Collective.findBySlug(args.slug.toLowerCase());
    }
  },

  Tier: {
    type: TierType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) }
    },
    resolve(_, args) {
      return models.Tier.findById(args.id);
    }
  },

  MatchingFund: {
    type: PaymentMethodType,
    description: "Fetch data about a matching fund from the short version of its UUID (first part)",
    args: {
      uuid: { type: new GraphQLNonNull(GraphQLString) },
      ForCollectiveId: { type: GraphQLInt }
    },
    resolve(_, args) {
      return models.PaymentMethod.getMatchingFund(args.uuid, { ForCollectiveId: args.ForCollectiveId });
    }
  },

  LoggedInUser: {
    type: UserType,
    resolve(_, args, req) {
      return req.remoteUser;
    }
  },

  allInvoices: {
    type: new GraphQLList(InvoiceType),
    args: {
      fromCollectiveSlug: { type: new GraphQLNonNull(GraphQLString) }
    },
    async resolve(_, args, req) {
      const fromCollective = await models.Collective.findOne({ where: { slug: args.fromCollectiveSlug }});
      if (!fromCollective) {
        throw new errors.NotFound("User or organization not found");
      }
      if (!req.remoteUser || req.remoteUser.CollectiveId !== fromCollective.id) {
        throw new errors.Unauthorized("You don't have permission to access invoices for this user");
      }

      const transactions = await models.Transaction.findAll({
        attributes: [ 'createdAt', 'HostCollectiveId', 'amountInHostCurrency', 'hostCurrency'],
        where: {
          type: 'CREDIT',
          FromCollectiveId: fromCollective.id,
        }
      });
      const hostsById = {};
      const invoicesByKey = {};
      await Promise.map(transactions, async (transaction) => {
        const HostCollectiveId = transaction.HostCollectiveId;
        hostsById[HostCollectiveId] = hostsById[HostCollectiveId] || await models.Collective.findById(HostCollectiveId, { attributes: ['slug'] }); 
        const createdAt = new Date(transaction.createdAt);
        const year = createdAt.getFullYear();
        const month = createdAt.getMonth() + 1;
        const month2digit = month < 10 ? `0${month}`: `${month}`;
        const slug = `${year}${month2digit}-${hostsById[HostCollectiveId].slug}-${fromCollective.slug}`;
        const totalAmount = invoicesByKey[slug] ? invoicesByKey[slug].totalAmount + transaction.amountInHostCurrency : transaction.amountInHostCurrency;
        invoicesByKey[slug] = {
          HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          slug,
          year,
          month,
          totalAmount,
          currency: transaction.hostCurrency
        }
      });
      const invoices = [];
      Object.keys(invoicesByKey).forEach(key => invoices.push(invoicesByKey[key]));
      invoices.sort((a, b) => {
        return (a.slug > b.slug)
          ? -1
          : 1;
      })
      return invoices;
    }
  },

  Invoice: {
    type: InvoiceType,
    args: {
      invoiceSlug: {
        type: new GraphQLNonNull(GraphQLString),
        description: `Slug of the invoice. Format: :year:2digitMonth-:hostSlug-:fromCollectiveSlug`
      }
    },
    async resolve(_, args, req) {
      const year = args.invoiceSlug.substr(0, 4);
      const month = args.invoiceSlug.substr(4, 2);
      const hostSlug = args.invoiceSlug.substring(7, args.invoiceSlug.lastIndexOf('-'));
      const fromCollectiveSlug = args.invoiceSlug.substr(args.invoiceSlug.lastIndexOf('-') + 1);
      if (!hostSlug || year < 2015 || (month < 1 || month > 12)) {
        throw new errors.ValidationFailed(`Invalid invoiceSlug format. Should be :year:2digitMonth-:hostSlug-:fromCollectiveSlug`);
      }
      const fromCollective = await models.Collective.findOne({ where: { slug: fromCollectiveSlug }});
      if (!fromCollective) {
        throw new errors.NotFound("User or organization not found");
      }
      const host = await models.Collective.findBySlug(hostSlug);
        if (!host) {
          throw new errors.NotFound("Host not found");
        }
      if (!req.remoteUser || req.remoteUser.CollectiveId !== fromCollective.id) {
        throw new errors.Unauthorized("You don't have permission to access invoices for this user");
      }

      const startsAt = new Date(`${year}-${month}-01`);
      const endsAt = new Date(startsAt);
      endsAt.setMonth(startsAt.getMonth() + 1);

      const where = {
        FromCollectiveId: fromCollective.id,
        HostCollectiveId: host.id,
        createdAt: { $gte: startsAt, $lt: endsAt },
        type: 'CREDIT'
      };

      const transactions = await models.Transaction.findAll({ where });
      if (transactions.length === 0) {
        throw new errors.NotFound("No transactions found");
      }
      const invoice = {
        title: get(host, 'settings.invoiceTitle') || "Donation Receipt",
        HostCollectiveId: host.id,
        slug: args.invoiceSlug,
        year,
        month
      };
      let totalAmount = 0
      transactions.map(transaction => {
        totalAmount += transaction.amountInHostCurrency;
        invoice.currency = transaction.hostCurrency;
      })
      invoice.FromCollectiveId = fromCollective.id;
      invoice.totalAmount = totalAmount;
      invoice.transactions = transactions;
      return invoice;
    }
  },

  /*
   * Given a collective slug, returns all transactions
   */
  allTransactions: {
    type: new GraphQLList(TransactionInterfaceType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
    },
    async resolve(_, args) {
      const query = {
        where: {},
        order: [ ['createdAt', 'DESC'] ]
      };

      const CollectiveId = args.CollectiveId || await fetchCollectiveId(args.collectiveSlug);

      if (CollectiveId) query.where.CollectiveId = CollectiveId;
      if (args.type) query.where.type = args.type;
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;

      // Add date ranges to the query
      if (args.dateFrom || args.dateTo) {
        query.where.createdAt = {};
        if (args.dateFrom) query.where.createdAt['$gte'] = args.dateFrom;
        if (args.dateTo) query.where.createdAt['$lte'] = args.dateTo;
      }
      return models.Transaction.findAll(query);
    }
  },

  Update: {
    type: UpdateType,
    args: {
      collectiveSlug: { type: GraphQLString },
      updateSlug: { type: GraphQLString },
      id: { type: GraphQLInt }
    },
    async resolve(_, args) {
      if (args.id) {
        return models.Update.findById(args.id);
      }
      const CollectiveId = await fetchCollectiveId(args.collectiveSlug);
      return models.Update.findOne({ where: { CollectiveId, slug: args.updateSlug } });
    }
  },

  /*
   * Given a collective slug, returns all expenses
   */
  allUpdates: {
    type: new GraphQLList(UpdateType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt }
    },
    resolve(_, args, req) {
      const query = { where: {} };
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;
      query.order = [['publishedAt', 'DESC'], ['createdAt', 'DESC']];
      if (!req.remoteUser || !req.remoteUser.isAdmin(args.CollectiveId)) {
        query.where.publishedAt = { $ne: null };
      }
      return req.loaders.collective.findById.load(args.CollectiveId)
        .then(collective => {
          if (!collective) {
            throw new Error('Collective not found');
          }
          const getCollectiveIds = () => {
            // if is host, we get all the expenses across all the hosted collectives
            if (args.includeHostedCollectives) {
              return models.Member.findAll({
                where: {
                  MemberCollectiveId: collective.id,
                  role: 'HOST'
                }
              }).map(member => member.CollectiveId)
            } else {
              return Promise.resolve([args.CollectiveId]);
            }
          }
          return getCollectiveIds().then(collectiveIds => {
            query.where.CollectiveId = { $in: collectiveIds };
            return models.Update.findAll(query);
          })
        })
    }
  },

  /*
   * Given a collective slug, returns all expenses
   */
  allExpenses: {
    type: new GraphQLList(ExpenseType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      status: { type: GraphQLString },
      category: { type: GraphQLString },
      FromCollectiveId: { type: GraphQLInt },
      fromCollectiveSlug: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt }
    },
    async resolve(_, args, req) {
      const query = { where: {} };
      if (args.fromCollectiveSlug && !args.FromCollectiveId) {
        args.FromCollectiveId = await fetchCollectiveId(args.fromCollectiveSlug);
      }
      if (args.FromCollectiveId) {
        const user = await models.User.findOne({ attributes: ['id'], where: { CollectiveId: args.FromCollectiveId }});
        query.where.UserId = user.id;
      }
      if (args.status) query.where.status = args.status;
      if (args.category) query.where.category = { $iLike: args.category };
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;
      query.order = [["incurredAt", "DESC"]];
      return req.loaders.collective.findById.load(args.CollectiveId)
        .then(collective => {
          if (!collective) {
            throw new Error('Collective not found');
          }
          const getCollectiveIds = () => {
            // if is host, we get all the expenses across all the hosted collectives
            if (args.includeHostedCollectives) {
              return models.Member.findAll({
                where: {
                  MemberCollectiveId: collective.id,
                  role: 'HOST'
                }
              }).map(member => member.CollectiveId)
            } else {
              return Promise.resolve([args.CollectiveId]);
            }
          }
          return getCollectiveIds().then(collectiveIds => {
            query.where.CollectiveId = { $in: collectiveIds };
            return models.Expense.findAll(query);
          })
        })
    }
  },

  /*
   * Given an Expense id, returns the expense details
   */
  Expense: {
    type: ExpenseType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) }
    },
    resolve(_, args) {
      return models.Expense.findById(args.id);
    }
  },

  /*
   * Given a Transaction id, returns a transaction details
   */
  Transaction: {
    type: TransactionInterfaceType,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt)
      }
    },
    resolve(_, args) {
      return models.Transaction.findOne({ where: { id: args.id }});
    }
  },

  /*
   * Returns all collectives
   */
  allCollectives: {
    type: new GraphQLList(CollectiveInterfaceType),
    args: {
      tags: { type: new GraphQLList(GraphQLString) },
      type: {
        type: GraphQLString,
        description: "COLLECTIVE, USER, ORGANIZATION, EVENT"
      },
      HostCollectiveId: { type: GraphQLInt },
      hostCollectiveSlug: {
        type: GraphQLString,
        description: "Fetch all collectives hosted by hostCollectiveSlug"
      },
      memberOfCollectiveSlug: {
        type: GraphQLString,
        description: "Fetch all collectives that `memberOfCollectiveSlug` is a member of"
      },
      role: {
        type: GraphQLString,
        description: "Only fetch the collectives where `memberOfCollectiveSlug` has the specified role"
      },
      ParentCollectiveId: {
        type: GraphQLInt,
        description: "Fetch all collectives that are a child of `ParentCollectiveId`. Used for \"SuperCollectives\""
      },
      orderBy: { type: GraphQLString },
      orderDirection: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt }
    },
    async resolve(_, args) {
      const query = {
        where: {},
        limit: args.limit || 10,
        include: []
      };

      if (args.hostCollectiveSlug) {
        args.HostCollectiveId = await fetchCollectiveId(args.hostCollectiveSlug);
      }

      if (args.memberOfCollectiveSlug) {
        args.memberOfCollectiveId = await fetchCollectiveId(args.memberOfCollectiveSlug);
      }

      if (args.memberOfCollectiveId) {
        const memberCond = {
          model: models.Member,
          required: true,
          where: {
            MemberCollectiveId: args.memberOfCollectiveId
          }
        };
        if (args.role) memberCond.where.role = args.role.toUpperCase();
        query.include.push(memberCond);
      }

      if (args.HostCollectiveId) query.where.HostCollectiveId = args.HostCollectiveId;
      if (args.ParentCollectiveId) query.where.ParentCollectiveId = args.ParentCollectiveId;
      if (args.type) query.where.type = args.type;
      if (args.tags) query.where.tags = { $overlap: args.tags };

      if (args.orderBy === 'balance' && (args.ParentCollectiveId || args.HostCollectiveId || args.tags)) {
        return rawQueries.getCollectivesWithBalance(query.where, args);
      } else {
        query.order = [['name', 'ASC']];
      }

      if (args.offset) query.offset = args.offset;
      return models.Collective.findAll(query);
    }
  },

  /*
   * Given a collective slug, returns all members/memberships
   */
  allMembers: {
    type: new GraphQLList(MemberType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: {
        type: GraphQLBoolean,
        description: "Include the members of the hosted collectives. Useful to get the list of all users/organizations from a host."
      },
      memberCollectiveSlug: { type: GraphQLString },
      TierId: { type: GraphQLInt },
      role: { type: GraphQLString },
      type: { type: GraphQLString },
      orderBy: { type: GraphQLString },
      orderDirection: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt }
    },
    async resolve(_, args, req) {

      if (!args.CollectiveId && !args.collectiveSlug && !args.memberCollectiveSlug) {
        throw new Error("Please provide a CollectiveId, a collectiveSlug or a memberCollectiveSlug");
      }

      if (args.collectiveSlug) {
        args.CollectiveId = await fetchCollectiveId(args.collectiveSlug.toLowerCase());
      }

      if (args.memberCollectiveSlug) {
        args.MemberCollectiveId = await fetchCollectiveId(args.memberCollectiveSlug.toLowerCase());
      }

      const memberTable = args.MemberCollectiveId ? 'collective' : 'memberCollective';
      const attr = args.CollectiveId ? 'CollectiveId' : 'MemberCollectiveId';
      const where = { [attr]: args[attr] };
      if (args.role) where.role = args.role.toUpperCase();
      if (where.role === 'HOST') {
        where.HostCollectiveId = args.MemberCollectiveId;
      }
      
      const getCollectiveIds = () => {
        if (args.includeHostedCollectives) {
          return models.Member.findAll({
            where: {
              MemberCollectiveId: args.CollectiveId,
              role: 'HOST'
            }
          }).map(members => members.CollectiveId)
        } else {
          return Promise.resolve([args[attr]]);
        }
      }

      if (["totalDonations", "balance"].indexOf(args.orderBy) !== -1) {
        const queryName = (args.orderBy === 'totalDonations') ? "getMembersWithTotalDonations" : "getMembersWithBalance";
        return rawQueries[queryName](where, args)
          .map(collective => {
            const res = {
              id: collective.dataValues.MemberId,
              role: collective.dataValues.role,
              createdAt: collective.dataValues.createdAt,
              CollectiveId: collective.dataValues.CollectiveId,
              MemberCollectiveId: collective.dataValues.MemberCollectiveId,
              totalDonations: collective.dataValues.totalDonations
            }
            res[memberTable] = collective;
            return res;
          });
      } else {
        const query = { where, include: [] };
        if (args.TierId) query.where.TierId = args.TierId;

        // If we request the data of the member, we do a JOIN query
        // that allows us to sort by Member.member.name
        if (req.body.query.match(/ member ?\{/) || args.type) {
          const memberCond = {};
          if (args.type) {
            const types = args.type.split(',');
            memberCond.type = { $in: types };
          }
          query.include.push(
            {
              model: models.Collective,
              as: memberTable,
              required: true,
              where: memberCond
            }
          );
          query.order = [[sequelize.literal(`"${memberTable}".name`), 'ASC']];
        }
        if (args.limit) query.limit = args.limit;
        if (args.offset) query.offset = args.offset;
        
        return getCollectiveIds().then(collectiveIds => {
          query.where[attr] = { $in: collectiveIds };
          return models.Member.findAll(query);
        })
      }
    }
  },

  /*
   * Given a collective slug, returns all events
   */
  allEvents: {
    type: new GraphQLList(CollectiveInterfaceType),
    args: {
      slug: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt }
    },
    resolve(_, args) {
      if (args.slug) {
        return models.Collective
          .findBySlug(args.slug, { attributes: ['id'] })
          .then(collective => models.Collective.findAll({
            where: { ParentCollectiveId: collective.id, type: 'EVENT' },
            order: [['startsAt', 'DESC'], ['createdAt', 'DESC']],
            limit: args.limit || 10,
            offset: args.offset || 0
          }))
          .catch(e => {
            console.error(e.message);
            return [];
          })
      } else {
        return models.Collective.findAll({ where: { type: 'EVENT' }});
      }
    }
  },

  /*
   * Given a prepaid code, return validity and amount
   */
  prepaidPaymentMethod: {
    type: PaymentMethodType,
    args: {
      token: { type: new GraphQLNonNull(GraphQLString) }
    },
    resolve(_, args) {
      return models.PaymentMethod.findOne({
        where: { 
          token: args.token,
          expiryDate: {
            $gt: new Date()
          },
          archivedAt: null // archived PMs are assumed to be used or inactive
        }
      });
    }
  }
}

export default queries;
