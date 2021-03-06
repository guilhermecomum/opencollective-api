import { expect } from 'chai';
import { describe, it } from 'mocha';
import sinon from 'sinon';

import * as utils from './utils';
import models from '../server/models';
import roles from '../server/constants/roles';
import * as payments from '../server/lib/payments';
import emailLib from '../server/lib/email';

let host, user1, user2, collective1, event1, ticket1;
let sandbox, executeOrderStub, emailSendSpy, emailSendMessageSpy;

describe('Mutation Tests', () => {

  /* SETUP
    collective1: 2 events
      event1: 1 free ticket, 1 paid ticket
  */

  before(() => {
    sandbox = sinon.sandbox.create();
    emailSendSpy = sandbox.spy(emailLib, 'send');
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    executeOrderStub = sandbox.stub(payments, 'executeOrder',
      (user, order) => {
        // assumes payment goes through and marks Order as confirmedAt
        return models.Tier.findById(order.TierId)
          .then(tier => {
            if (tier.interval) {
              return models.Subscription.create({
                amount: tier.amount,
                currency: tier.currency,
                interval: tier.interval,
                isActive: true
              }).then(s => s.id);
            }
          })
          .then((SubscriptionId) => order.update({ SubscriptionId, processedAt: new Date() }))
          .then(() => models.Collective.findById(order.CollectiveId))
          .then(collective => collective.addUserWithRole(user, roles.BACKER, { MemberCollectiveId: order.FromCollectiveId, TierId: order.TierId }))
      });
  });

  after(() => sandbox.restore());

  beforeEach("reset db", () => utils.resetTestDB());

  beforeEach("create user1", () => models.User.createUserWithCollective(utils.data('user1')).tap(u => user1 = u));
  beforeEach("create host user 1", () => models.User.createUserWithCollective(utils.data('host1')).tap(u => host = u));

  beforeEach("create user2", () => models.User.createUserWithCollective(utils.data('user2')).tap(u => user2 = u));
  beforeEach("create collective1", () => models.Collective.create(utils.data('collective1')).tap(g => collective1 = g));
  beforeEach("add host", () => collective1.addHost(host.collective));
  beforeEach("add user1 as admin to collective1", () => collective1.addUserWithRole(user1, roles.ADMIN));

  beforeEach('create stripe account', (done) => {
    models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: host.collective.id
    })
    .tap(() => done())
    .catch(done);
  });

  beforeEach("create an event collective", () => models.Collective.create(
    Object.assign(utils.data('event1'), { CreatedByUserId: user1.id, ParentCollectiveId: collective1.id }))
    .tap(e => event1 = e));
  beforeEach("add user1 as admin of event1", () => event1.addUserWithRole(user1, roles.ADMIN));
    
  describe('createCollective tests', () => {

    const createCollectiveQuery = `
    mutation createCollective($collective: CollectiveInputType!) {
      createCollective(collective: $collective) {
        id
        slug
        host {
          id
        }
        isActive
        tiers {
          id
          name
          amount
          presets
        }
      }
    }
    `;

    describe('creates an event collective', () => {

      const getEventData = (collective) => {
        return {
          "name": "BrusselsTogether Meetup 3",
          "type": "EVENT",
          "longDescription": "Hello Brussels!\n\nAccording to the UN, by 2050 66% of the world’s population will be urban dwellers, which will profoundly affect the role of modern city-states on Earth.\n\nToday, citizens are already anticipating this futurist trend by creating numerous initiatives inside their local communities and outside of politics.\n\nIf you want to be part of the change, please come have a look to our monthly events! You will have the opportunity to meet real actors of change and question them about their purpose. \n\nWe also offer the opportunity for anyone interested to come before the audience and share their ideas in 60 seconds at the end of the event.\n\nSee more about #BrusselsTogether radical way of thinking below.\n\nhttps://brusselstogether.org/\n\nGet your ticket below and get a free drink thanks to our sponsor! 🍻🎉\n\n**Schedule**\n\n7 pm - Doors open\n\n7:30 pm - Introduction to #BrusselsTogether\n\n7:40 pm - Co-Labs, Citizen Lab of Social Innovations\n\n7:55 pm - BeCode.org, growing today’s talented youth into tomorrow’s best developers.\n\n8:10 pm - OURB, A city building network\n\n8:30 pm - How do YOU make Brussels better \nPitch your idea in 60 seconds or less\n","location": {"name": "Brass'Art Digitaal Cafe","address":"Place communale de Molenbeek 28"},
          "startsAt": "Wed Apr 05 2017 10:00:00 GMT-0700 (PDT)",
          "endsAt": "Wed Apr 05 2017 12:00:00 GMT-0700 (PDT)",
          "timezone": "Europe/Brussels",
          "ParentCollectiveId": collective.id,
          "tiers": [
            {"name":"free ticket","description":"Free ticket","amount": 0},
            {"name":"sponsor","description":"Sponsor the drinks. Pretty sure everyone will love you.","amount": 15000}
          ]
        };
      };

      it("fails if not authenticated", async () => {
        const result = await utils.graphqlQuery(createCollectiveQuery, { collective: getEventData(collective1) });
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal("You need to be logged in to create a collective");
      });


      it("fails if authenticated but cannot edit collective", async () => {
        const result = await utils.graphqlQuery(createCollectiveQuery, { collective: getEventData(collective1) }, user2);
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal("You must be logged in as a member of the scouts collective to create an event");
      });

      it("creates a collective on a host", async () => {
        const collective = {
          name: "new collective",
          HostCollectiveId: host.CollectiveId
        }
        const result = await utils.graphqlQuery(createCollectiveQuery, { collective }, user1);
        result.errors && console.error(result.errors[0]);
        const createdCollective = result.data.createCollective;
        const hostMembership = await models.Member.findOne({ where: { CollectiveId: createdCollective.id, role: 'HOST' }});
        const adminMembership = await models.Member.findOne({ where: { CollectiveId: createdCollective.id, role: 'ADMIN' }});
        expect(createdCollective.host.id).to.equal(host.CollectiveId);
        expect(createdCollective.tiers).to.have.length(2);
        expect(createdCollective.tiers[0].presets).to.have.length(4);
        expect(createdCollective.isActive).to.be.false;
        expect(hostMembership.MemberCollectiveId).to.equal(host.CollectiveId);
        expect(adminMembership.MemberCollectiveId).to.equal(user1.CollectiveId);
      });

      it("creates an event with multiple tiers", async () => {

        const event = getEventData(collective1);

        const result = await utils.graphqlQuery(createCollectiveQuery, { collective: event }, user1);
        result.errors && console.error(result.errors[0]);
        const createdEvent = result.data.createCollective;
        expect(createdEvent.slug).to.equal(`brusselstogether-meetup-3-4ev`);
        expect(createdEvent.tiers.length).to.equal(event.tiers.length);
        expect(createdEvent.isActive).to.be.true;
        event.id = createdEvent.id;
        event.slug = 'newslug';
        event.tiers = createdEvent.tiers;

        // Make sure the creator of the event has been added as an ADMIN
        const members = await models.Member.findAll({ where: {
          CollectiveId: event.id
        }});

        expect(members).to.have.length(1);
        expect(members[0].CollectiveId).to.equal(event.id);
        expect(members[0].MemberCollectiveId).to.equal(user1.CollectiveId);
        expect(members[0].role).to.equal(roles.ADMIN);

        // We remove the first tier
        event.tiers.shift();

        // We update the second (now only) tier
        event.tiers[0].amount = 123;

        const updateQuery = `
        mutation editCollective($collective: CollectiveInputType!) {
          editCollective(collective: $collective) {
            id,
            slug,
            tiers {
              id,
              name,
              amount
            }
          }
        }
        `;

        const r2 = await utils.graphqlQuery(updateQuery, { collective: event });
        expect(r2.errors).to.have.length(1);
        expect(r2.errors[0].message).to.equal("You need to be logged in to edit a collective");

        const r3 = await utils.graphqlQuery(updateQuery, { collective: event }, user2);
        expect(r3.errors).to.have.length(1);
        expect(r3.errors[0].message).to.equal("You must be logged in as the creator of this Event or as an admin of the scouts collective to edit this Event Collective");

        const r4 = await utils.graphqlQuery(updateQuery, { collective: event }, user1);
        const updatedEvent = r4.data.editCollective;
        expect(updatedEvent.slug).to.equal(`${event.slug}-${event.ParentCollectiveId}ev`);
        expect(updatedEvent.tiers.length).to.equal(event.tiers.length);
        expect(updatedEvent.tiers[0].amount).to.equal(event.tiers[0].amount);

      })
    })

    describe('apply to create a collective', () => {
      let newCollectiveData;

      beforeEach(() => {
        newCollectiveData = {
          slug: "newcollective",
          name: "new collective",
          website: "http://newcollective.org",
          twitterHandle: "newcollective",
          HostCollectiveId: host.collective.id
        };
      })

      it("fails if not logged in", async () => {
        const res = await utils.graphqlQuery(createCollectiveQuery, { collective: newCollectiveData });
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.contain("You need to be logged in to create a collective");
      });

      it("creates a collective", async () => {
        const res = await utils.graphqlQuery(createCollectiveQuery, { collective: newCollectiveData }, user1);
        res.errors && console.error(res.errors[0]);
        const newCollective = res.data.createCollective;
        expect(newCollective.isActive).to.be.false;
        expect(newCollective.host.id).to.equal(host.collective.id);
        await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
        expect(emailSendMessageSpy.callCount).to.equal(1);
        expect(emailSendMessageSpy.firstCall.args[0]).to.equal(host.email);
        expect(emailSendMessageSpy.firstCall.args[1]).to.contain("New collective pending new collective");
      });
    })

    describe('edit tiers', () => {

      const editTiersQuery = `
      mutation editTiers($id: Int!, $tiers: [TierInputType]) {
        editTiers(id: $id, tiers: $tiers) {
          id
          name
          type
          amount
          interval
          goal
        }
      }
      `;

      const tiers = [
        { name: "backer", type: "TIER", amount: 10000, interval: "month" },
        { name: "sponsor", type: "TIER", amount: 500000, interval: "year" }
      ];

      it('fails if not authenticated', async () => {
        const result = await utils.graphqlQuery(editTiersQuery, { id: collective1.id, tiers });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal("You need to be logged in to edit tiers");
      });

      it('fails if not authenticated as host or member of collective', async () => {
        const result = await utils.graphqlQuery(editTiersQuery, { id: collective1.id }, user2);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal("You need to be logged in as a core contributor or as a host of the Scouts d'Arlon collective");
      });

      it('add new tiers and update existing', async () => {
        const result = await utils.graphqlQuery(editTiersQuery, { id: collective1.id, tiers }, user1);
        result.errors && console.error(result.errors[0]);
        expect(tiers).to.have.length(2);
        tiers.sort((a, b) => b.amount - a.amount);
        expect(tiers[0].interval).to.equal('year');
        expect(tiers[1].interval).to.equal('month');
        tiers[0].goal = 20000;
        tiers[1].amount = 100000;
        tiers.push({name: "free ticket", type: "TICKET", amount: 0});
        const result2 = await utils.graphqlQuery(editTiersQuery, { id: collective1.id, tiers }, user1);
        result2.errors && console.error(result2.errors[0]);
        const updatedTiers = result2.data.editTiers;
        updatedTiers.sort((a, b) => b.amount - a.amount);
        expect(updatedTiers).to.have.length(3);
        expect(updatedTiers[0].goal).to.equal(tiers[0].goal);
        expect(updatedTiers[1].amount).to.equal(tiers[1].amount);
      })
    })
  })

  describe('delete Collective', () => {

    const deleteCollectiveQuery = `
      mutation deleteCollective($id: Int!) {
        deleteCollective(id: $id) {
          id,
          name
        }
      }`;

    it('fails to delete a collective if not logged in', async () => {
      const result = await utils.graphqlQuery(deleteCollectiveQuery, { id: event1.id });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You need to be logged in to delete a collective");
      return models.Collective.findById(event1.id).then(event => {
        expect(event).to.not.be.null;
      })
    });

    it('fails to delete a collective if logged in as another user', async () => {
      const result = await utils.graphqlQuery(deleteCollectiveQuery, { id: event1.id }, user2);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You need to be logged in as a core contributor or as a host to delete this collective");
      return models.Collective.findById(event1.id).then(event => {
        expect(event).to.not.be.null;
      })
    });

    it('deletes a collective', async () => {
      const res = await utils.graphqlQuery(deleteCollectiveQuery, { id: event1.id }, user1);
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      return models.Collective.findById(event1.id).then(event => {
        expect(event).to.be.null;
      })
    });
  });

  describe('createOrder tests', () => {

    beforeEach("create ticket 1", () => models.Tier.create(
      Object.assign(utils.data('ticket1'), { CollectiveId: event1.id }))
      .tap(t => ticket1 = t));

    beforeEach("create ticket 2", () => models.Tier.create(
      Object.assign(utils.data('ticket2'), { CollectiveId: event1.id })));

    beforeEach("create tier 1", () => models.Tier.create(
      Object.assign(utils.data('tier1'), { CollectiveId: collective1.id })));

    describe('throws an error', () => {

      it('when missing all required fields', async () => {
        const query = `
          mutation createOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              id,
              collective {
                id
              }
              tier {
                id,
                name,
                description
              }
            }
          }
        `;

        const result = await utils.graphqlQuery(query, { order: {} });
        expect(result.errors.length).to.equal(1);
        expect(result.errors[0].message).to.contain('collective');
      });

      describe('when collective/tier doesn\'t exist', () => {

        it('when collective doesn\'t exist', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                collective {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;
          const order = {
            user: { email: user1.email },
            collective: { id: 12324 },
            tier: { id: 1 },
            quantity:1 
          };
          const result = await utils.graphqlQuery(query, { order });
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal(`No collective found with id: ${order.collective.id}`);
        });

        it('when tier doesn\'t exist', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                collective {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;

          const order = {
            user: { email: "user@email.com" },
            collective: { id: event1.id },
            tier: { id: 1002 },
            quantity: 1
          };
          const result = await utils.graphqlQuery(query, { order });
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal(`No tier found with tier id: 1002 for collective slug ${event1.slug}`);
        });
      });

      describe('after checking ticket quantity', () => {
        it('and if not enough are available', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                collective {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;

          const order = {
            user: { email: "user@email.com" },
            collective: { id: event1.id },
            tier: { id: 1 },
            quantity: 101
          };
          const result = await utils.graphqlQuery(query, { order });
          expect(result.errors[0].message).to.equal(`No more tickets left for ${ticket1.name}`);
        });
      });

      describe('when no payment method', () => {
        it('and it\'s a paid ticket', async () => {
           const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                collective {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;

          const order = {
            user:{ email: "user@email.com" },
            collective: { id: event1.id },
            tier: { id: 2 },
            quantity: 2
          };
          const result = await utils.graphqlQuery(query, { order });
          expect(result.errors[0].message).to.equal('This order requires a payment method');
        });
      });
    });

    describe('members', () => {

      it('creates a new member with an existing user', async () => {
        const createMemberQuery = `
          mutation createMember {
            createMember(
              member: { email: "${user2.email}" },
              collective: { id: ${event1.id} },
              role: "FOLLOWER"
            ) {
              id,
              role,
              member {
                id,
                ... on User {
                  email
                }
              },
              collective {
                id,
                slug
              }
            }
          }
        `;
        const result = await utils.graphqlQuery(createMemberQuery);
        expect(result).to.deep.equal({
          data: {
            "createMember": {
              "id": 4,
              "role": "FOLLOWER",
              "member": {
                "email": null, // note: since the logged in user cannot edit the collective, it cannot get back the email address of an order
                "id": 3
              },
              "collective": {
                "id": 5,
                "slug": "jan-meetup"
              }
            }
          }
        });
      });

      it('removes a member', async () => {
        const removeMemberQuery = `
          mutation removeMember($member: CollectiveAttributesInputType!, $collective: CollectiveAttributesInputType!, $role: String!) {
            removeMember(member: $member, collective: $collective, role: $role) { id }
          }
        `;

        const error1 = await utils.graphqlQuery(removeMemberQuery, { member: { id: 3 }, collective: { id: event1.id }, role: "FOLLOWER" });
        expect(error1.errors[0].message).to.equal('Member not found');

        await models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: event1.id,
          role: 'FOLLOWER'
        });

        const error3 = await utils.graphqlQuery(removeMemberQuery, { member: { id: user1.id }, collective: { id: event1.id }, role: "FOLLOWER" }, user2);
        expect(error3.errors[0].message).to.equal(`You need to be logged in as this user or as a core contributor or as a host of the collective id ${event1.id}`);
        
        const membersBefore = await models.Member.count();
        const res = await utils.graphqlQuery(removeMemberQuery, { member: { id: user1.id }, collective: { id: event1.id }, role: "FOLLOWER" }, user1);
        res.errors && console.error(res.errors);
        const membersAfter = await models.Member.count();
        expect(membersBefore - membersAfter).to.equal(1);
      })
    });

    describe('creates an order', () => {

      beforeEach("reset spies", () => {
        executeOrderStub.reset();
        emailSendSpy.reset();
        emailSendMessageSpy.reset();
      });

      describe('as an organization', () => {

        const query = `
          mutation createOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              id,
              tier {
                id,
              },
              fromCollective {
                slug
                twitterHandle
              },
              collective {
                id,
                slug
              }
            }
          }
        `;

        it('as a new organization', async () => {

          const order = {
            user: { email: user2.email },
            fromCollective: {
              name: "Google",
              website: "https://google.com",
              twitterHandle: "google"
            },
            paymentMethod: {
              token: "tok_123456781234567812345678",
              service: "stripe",
              name: "4242",
              data: {
                expMonth: 11,
                expYear: 2020
              }
            },
            collective: { id: collective1.id },
            publicMessage: "Looking forward!",
            tier: { id: 3 },
            quantity: 2
          };
          const result = await utils.graphqlQuery(query, { order });
          result.errors && console.error(result.errors);
          expect(result.data).to.deep.equal({
            "createOrder": {
              "fromCollective": {
                "slug": "google",
                "twitterHandle": "google"
              },
              "collective": {
                "id": collective1.id,
                "slug": collective1.slug
              },
              "id": 1,
              "tier": {
                "id": 3
              }
            }
          });

          // Make sure we have added the user as a BACKER
          const members = await models.Member.findAll({
            where: {
              CollectiveId: collective1.id,
              role: roles.BACKER
            }
          });
          await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
          expect(members).to.have.length(1);

          // Make sure we send the collective.member.created email notification to core contributor of collective1
          expect(emailSendMessageSpy.callCount).to.equal(1);
          expect(emailSendMessageSpy.firstCall.args[0]).to.equal("user1@opencollective.com");
          expect(emailSendMessageSpy.firstCall.args[1]).to.equal("Google joined Scouts d'Arlon as backer");
          expect(emailSendMessageSpy.firstCall.args[2]).to.contain("Looking forward!"); // publicMessage
          expect(emailSendMessageSpy.firstCall.args[2]).to.contain("@google thanks for your donation to @scouts");
        });

        it('as an existing organization', async () => {

          const org = await models.Collective.create({
            type: "ORGANIZATION",
            name: "Slack",
            website: "https://slack.com",
            description: "Supporting open source since 1999",
            twitterHandle: "slack",
            image: "http://www.endowmentwm.com/wp-content/uploads/2017/07/slack-logo.png"
          });

          await org.addUserWithRole(user2, roles.ADMIN);

          const order = {
            user: { email: user2.email },
            fromCollective: {
              id: org.id
            },
            paymentMethod: {
              token: "tok_123456781234567812345678",
              service: "stripe",
              name: "4242",
              data: {
                expMonth: 11,
                expYear: 2020
              }
            },
            collective: { id: collective1.id },
            publicMessage: "Looking forward!",
            tier: { id: 3 },
            quantity: 2
          };
          const result = await utils.graphqlQuery(query, { order }, user2);
          result.errors && console.error(result.errors);
          expect(result.data).to.deep.equal({
            "createOrder": {
              "fromCollective": {
                "slug": "slack",
                "twitterHandle": "slack"
              },
              "collective": {
                "id": collective1.id,
                "slug": collective1.slug
              },
              "id": 1,
              "tier": {
                "id": 3
              }
            }
          });

          // Make sure we have added the user as a BACKER
          const members = await models.Member.findAll({
            where: {
              CollectiveId: collective1.id,
              role: roles.BACKER
            }
          });
          expect(members).to.have.length(1);
          await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
          expect(emailSendSpy.callCount).to.equal(1);
          const activityData = emailSendSpy.lastCall.args[2];
          expect(activityData.member.role).to.equal(roles.BACKER);
          expect(activityData.collective.type).to.equal("COLLECTIVE");
          expect(activityData.order.publicMessage).to.equal("Looking forward!");
          expect(activityData.order.subscription.interval).to.equal("month");
          expect(activityData.collective.slug).to.equal(collective1.slug);
          expect(activityData.member.memberCollective.slug).to.equal("slack");
          expect(emailSendSpy.lastCall.args[0]).to.equal("collective.member.created");
          expect(emailSendMessageSpy.lastCall.args[0]).to.equal(user1.email);
        });
      });

      describe('in a free ticket', () => {

        it('from an existing user', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                createdByUser {
                  id,
                  email
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  stats {
                    totalOrders
                    availableQuantity
                  }
                },
                fromCollective {
                  id,
                  slug
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;

          const order = {
            user: { email: user2.email },
            collective: { id: event1.id },
            publicMessage: "Looking forward!",
            tier: { id: 1 },
            quantity: 2
          };
          const result = await utils.graphqlQuery(query, { order });
          result.errors && console.error(result.errors);
          expect(result.data).to.deep.equal({
            "createOrder": {
              "fromCollective": {
                "id": user2.CollectiveId,
                "slug": user2.collective.slug
              },
              "collective": {
                "id": event1.id,
                "slug": event1.slug
              },
              "id": 1,
              "tier": {
                "description": "free tickets for all",
                "id": 1,
                "maxQuantity": 10,
                "name": "Free ticket",
                "stats": {
                  "availableQuantity": 8,
                  "totalOrders": 1
                }
              },
              "createdByUser": {
                "email": null,
                "id": 3
              }
            }
          });

          // Make sure we have added the user as an ATTENDEE
          const members = await models.Member.findAll({
            where: {
              CollectiveId: event1.id,
              role: roles.ATTENDEE
            }
          });
          expect(members).to.have.length(1);
          expect(emailSendSpy.callCount).to.equal(2);
          const activityData = emailSendSpy.lastCall.args[2];
          expect(activityData.member.role).to.equal("ATTENDEE");
          expect(activityData.collective.type).to.equal("EVENT");
          expect(activityData.order.publicMessage).to.equal("Looking forward!");
          expect(activityData.collective.slug).to.equal(event1.slug);
          expect(activityData.member.memberCollective.slug).to.equal(user2.collective.slug);
          expect(emailSendSpy.firstCall.args[0]).to.equal('ticket.confirmed');
          expect(emailSendSpy.secondCall.args[0]).to.equal('collective.member.created');
          await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          expect(emailSendMessageSpy.firstCall.args[0]).to.equal("user2@opencollective.com");
          expect(emailSendMessageSpy.firstCall.args[1]).to.equal("2 tickets confirmed for January meetup");
          expect(emailSendMessageSpy.secondCall.args[0]).to.equal("user1@opencollective.com");
          expect(emailSendMessageSpy.secondCall.args[1]).to.equal("Anish Bas joined January meetup as attendee");
        });

        it('from a new user', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                createdByUser {
                  id
                  email
                }
                tier {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    availableQuantity
                  }
                }
              }
            }
        `;

        const order = {
          user: { email: "newuser@email.com" },
          collective: { id: event1.id },
          tier: { id: 1 },
          quantity: 2
        };

        const result = await utils.graphqlQuery(query, { order });
        expect(result).to.deep.equal({
          data: {
            "createOrder": {
              "id": 1,
              "tier": {
                "description": "free tickets for all",
                "id": 1,
                "maxQuantity": 10,
                "name": "Free ticket",
                "stats": {                  
                  "availableQuantity": 8,
                }
              },
              "createdByUser": {
                "email": null,
                "id": 4
              }
            }
          }
        });

        // Make sure we have added the user as an ATTENDEE
        const members = await models.Member.findAll({
          where: {
            CollectiveId: event1.id,
            role: roles.ATTENDEE
          }
        });
        expect(members).to.have.length(1);
        });
      });

      describe('in a paid ticket', () => {

        it('from an existing user', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                createdByUser {
                  id,
                  email
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  stats {
                    availableQuantity
                  }
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;

          const order = {
            user: {
              email: user2.email,
            },
            paymentMethod: {
              token: "tok_123456781234567812345678",
              service: "stripe",
              name: "4242",
              data: {
                expMonth: 11,
                expYear: 2020
              }
            },
            collective: { id: event1.id },
            tier: { id: 2 },
            quantity:2
          };
          const result = await utils.graphqlQuery(query, { order });
          result.errors && console.error(result.errors[0]);
          expect(result.data).to.deep.equal({
            "createOrder": {
              "id": 1,
              "tier": {
                "stats": {
                  "availableQuantity": 98,
                },
                "description": "$20 ticket",
                "id": 2,
                "maxQuantity": 100,
                "name": "paid ticket"
              },
              "createdByUser": {
                "email": null,
                "id": 3
              },
              "collective": {
                "id": event1.id,
                "slug": "jan-meetup"
              }
            }
          });
          const executeOrderArgument = executeOrderStub.firstCall.args;
          expect(executeOrderStub.callCount).to.equal(1);
          executeOrderStub.reset();
          expect(executeOrderArgument[1].id).to.equal(1);
          expect(executeOrderArgument[1].TierId).to.equal(2);
          expect(executeOrderArgument[1].CollectiveId).to.equal(5);
          expect(executeOrderArgument[1].CreatedByUserId).to.equal(3);
          expect(executeOrderArgument[1].totalAmount).to.equal(4000);
          expect(executeOrderArgument[1].currency).to.equal('USD');
          expect(executeOrderArgument[1].paymentMethod.token).to.equal('tok_123456781234567812345678');
          await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
          expect(emailSendMessageSpy.callCount).to.equal(1);
          expect(emailSendMessageSpy.firstCall.args[0]).to.equal(user1.email);
          expect(emailSendMessageSpy.firstCall.args[1]).to.contain(`Anish Bas joined ${event1.name} as backer`);
        });

        it('from a new user', async () => {
          const query = `
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id,
                createdByUser {
                  id,
                  email
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  stats {
                    availableQuantity
                  }
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;

          const order = {
            user: {
              email: "newuser@email.com",
            },
            paymentMethod: {
              token: "tok_123456781234567812345678",
              name: "4242",
              data: {
                expMonth: 11,
                expYear: 2020
              }
            },
            collective: { id: event1.id },
            tier: { id: 2 },
            quantity: 2
          };
          const result = await utils.graphqlQuery(query, { order });
          result.errors && console.error(result.errors[0]);
          const executeOrderArgument = executeOrderStub.firstCall.args;
          expect(result).to.deep.equal({
            data: {
              "createOrder": {
                "id": 1,
                "tier": {
                  "description": "$20 ticket",
                  "id": 2,
                  "maxQuantity": 100,
                  "name": "paid ticket",
                  "stats": {
                    "availableQuantity": 98,                    
                  }
                },
                "createdByUser": {
                  "email": null,
                  "id": 4
                },
                "collective": {
                  "id": 5,
                  "slug": "jan-meetup"
                }
              }
            }
          });

          expect(executeOrderStub.callCount).to.equal(1);
          expect(executeOrderArgument[1].id).to.equal(1);
          expect(executeOrderArgument[1].TierId).to.equal(2);
          expect(executeOrderArgument[1].CollectiveId).to.equal(5);
          expect(executeOrderArgument[1].CreatedByUserId).to.equal(4);
          expect(executeOrderArgument[1].totalAmount).to.equal(4000);
          expect(executeOrderArgument[1].currency).to.equal('USD');
          expect(executeOrderArgument[1].paymentMethod.token).to.equal('tok_123456781234567812345678');
          await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
          expect(emailSendMessageSpy.callCount).to.equal(1);
          expect(emailSendMessageSpy.firstCall.args[0]).to.equal(user1.email);
          expect(emailSendMessageSpy.firstCall.args[1]).to.contain("anonymous joined January meetup as backer");
        });
      });
    });
  });
});