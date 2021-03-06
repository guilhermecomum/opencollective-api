import paypal from 'paypal-rest-sdk';
import async from 'async';
import config from 'config';

// NOT USED CURRENTLY.
// Leaving here for now so we can bring this back in near future
// TODO: should be moved to paypal payment provider under paymentProviders/

/**
 * We will pass the config in all the subsequent calls to be sure we don't
 * overwrite the configuration of the global sdk
 * Example: https://github.com/paypal/PayPal-node-SDK/blob/master/samples/configuration/multiple_config.js
 */
const getConfig = (connectedAccount) => ({
  mode: config.paypal.rest.mode,
  client_id: connectedAccount.clientId,
  client_secret: connectedAccount.token
});

const getCallbackUrl = (collective, transaction) => `${config.host.api}/collectives/${collective.id}/transactions/${transaction.id}/callback`;

const createBillingPlan = (planDescription, collective, transaction, subscription, paypalConfig, cb) => {
  const callbackUrl = getCallbackUrl(collective, transaction);

  const { amount } = transaction;
  const { currency } = transaction;
  const { interval } = subscription;
  // Paypal frequency is uppercase: 'MONTH'
  const frequency = interval.toUpperCase();

  const billingPlan = {
    description: planDescription,
    name: `Plan for ${planDescription}`,
    merchant_preferences: {
      cancel_url: callbackUrl,
      return_url: callbackUrl
    },
    payment_definitions: [{
      amount: {
        currency,
        value: amount
      },
      cycles: '0',
      frequency,
      frequency_interval: '1',
      name: `Regular payment`,
      type: 'REGULAR' // or TRIAL
    }],
    type: 'INFINITE' // or FIXED
  };

  paypal.billingPlan.create(billingPlan, paypalConfig, cb);
};

const createBillingAgreement = (agreementDescription, planId, paypalConfig, cb) => {
  // From paypal example, fails with moment js, TO REFACTOR
  const isoDate = new Date();
  isoDate.setSeconds(isoDate.getSeconds() + 4);
  isoDate.toISOString().slice(0, 19) + 'Z';  // eslint-disable-line

  const billingAgreement = {
    name: `Agreement for ${agreementDescription}`,
    description: agreementDescription,
    start_date: isoDate,
    plan: {
      id: planId
    },
    payer: {
      payment_method: 'paypal'
    }
  };

  paypal.billingAgreement.create(billingAgreement, paypalConfig, cb);
}

/**
 * Create a subscription payment and return the links to the paypal approval
 */
const createSubscription = (connectedAccount, collective, transaction, subscription, callback) => {
  const paypalConfig = getConfig(connectedAccount);
  const description = `donation of ${transaction.currency} ${transaction.amount} / ${subscription.interval} to ${collective.name}`;

  async.auto({
    createBillingPlan: (cb) => {
      createBillingPlan(
        description,
        collective,
        transaction,
        subscription,
        paypalConfig,
        cb
      );
    },

    activatePlan: ['createBillingPlan', (cb, results) => {
      paypal.billingPlan.activate(
        results.createBillingPlan.id,
        paypalConfig,
        cb
      );
    }],

    createBillingAgreement: ['activatePlan', (cb, results) => {
      createBillingAgreement(
        description,
        results.createBillingPlan.id,
        paypalConfig,
        cb
      );
    }]

  }, (err, results) => {
    if (err) return callback(err);

    return callback(null, {
      billingPlan: results.createBillingPlan,
      billingAgreement: results.createBillingAgreement
    })
  });
};

/**
 * Create a single payment
 * https://developer.paypal.com/docs/rest/api/payments/#payment.create
 */
const createPayment = (connectedAccount, collective, transaction, callback) => {
  const { amount, currency } = transaction;
  const callbackUrl = getCallbackUrl(collective, transaction);
  const paypalConfig = getConfig(connectedAccount);

  const payment = {
    intent: 'sale',
    payer: {
      payment_method: 'paypal'
    },
    redirect_urls: {
        return_url: callbackUrl,
        cancel_url: callbackUrl
    },
    transactions: [{
      amount: {
        currency,
        total: amount
      },
      description: `Donation to ${collective.name} (${currency} ${amount})`
    }]
  };

  paypal.payment.create(payment, paypalConfig, callback);
};

/**
 * Execute a payment
 * https://developer.paypal.com/docs/rest/api/payments/#payment.execute
 */

const execute = (connectedAccount, token, paymentId, PayerID, cb) => {
  const paypalConfig = getConfig(connectedAccount);

  // Single payment
  if (paymentId && PayerID) {
    paypal.payment.execute(paymentId, { payer_id: PayerID }, paypalConfig, cb);
  } else {
    paypal.billingAgreement.execute(token, {}, paypalConfig, cb);
  }

}

export { createSubscription, createPayment, execute };
