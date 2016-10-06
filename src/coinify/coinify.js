/* To use this class, three things are needed:
1 - a delegate object with functions that provide the following:
      save() -> e.g. function () { return JSON.stringify(this._coinify); }
      email() -> String            : the users email address
      isEmailVerified() -> Boolean : whether the users email is verified
      getEmailToken() -> stringify : JSON web token {email: 'me@example.com'}
      monitorAddress(address, callback) : callback(amount) if btc received
      checkAddress(address) : look for existing transaction at address
      getReceiveAddress(trade) : return the trades receive address
      reserveReceiveAddress()
      commitReceiveAddress()
      releaseReceiveAddress()
      serializeExtraFields(obj, trade) : e.g. obj.account_index = ...
      deserializeExtraFields(obj, trade)

2 - a Coinify parner identifier

var object = {user: 1, offline_token: 'token'};
var coinify = new Coinify(object, delegate);
coinify.partnerId = ...;
coinify.delegate.save.bind(coinify.delegate)()
// "{"user":1,"offline_token":"token"}"
*/

var Exchange = require('../exchange/exchange');
var CoinifyProfile = require('./profile');
var Trade = require('./trade');
var CoinifyKYC = require('./kyc');
var PaymentMethod = require('./payment-method');
var ExchangeRate = require('./exchange-rate');
var Quote = require('./quote');
var API = require('./api');

var assert = require('assert');
var Helpers = require('../exchange/helpers');

class Coinify extends Exchange {
  constructor (object, delegate) {
    super(delegate, Trade);

    var obj = object || {};
    this._partner_id = null;
    this._user = obj.user;
    this._auto_login = obj.auto_login;
    this._offlineToken = obj.offline_token;

    this._api = new API('https://app-api.coinify.com/');
    this._api._offlineToken = this._offlineToken;

    this._profile = new CoinifyProfile(this._api);
    this._lastQuote = null;

    this._buyCurrencies = null;
    this._sellCurrencies = null;

    this._trades = [];
    if (obj.trades) {
      for (let tradeObj of obj.trades) {
        var trade = new Trade(tradeObj, this._api, delegate, this);
        trade.debug = this._debug;
        this._trades.push(trade);
      }
    }

    this._kycs = [];

    this.exchangeRate = new ExchangeRate(this._api);
  }

  get profile () {
    if (!this._profile._did_fetch) {
      return null;
    } else {
      return this._profile;
    }
  }

  get kycs () { return this._kycs; }

  get hasAccount () { return Boolean(this._offlineToken); }

  get partnerId () { return this._partner_id; }
  set partnerId (value) {
    this._partner_id = value;
  }

  get buyCurrencies () { return this._buyCurrencies; }

  get sellCurrencies () { return this._sellCurrencies; }

  toJSON () {
    var coinify = {
      user: this._user,
      offline_token: this._offlineToken,
      auto_login: this._auto_login,
      trades: this._TradeClass.filteredTrades(this._trades)
    };

    return coinify;
  }

  // Country and default currency must be set
  // Email must be set and verified
  signup (countryCode, currencyCode) {
    var self = this;
    var runChecks = function () {
      assert(!self.user, 'Already signed up');

      assert(self.delegate, 'ExchangeDelegate required');

      assert(
        countryCode &&
        Helpers.isString(countryCode) &&
        countryCode.length === 2 &&
        countryCode.match(/[a-zA-Z]{2}/),
        'ISO 3166-1 alpha-2'
      );

      assert(currencyCode, 'currency required');

      assert(self.delegate.email(), 'email required');
      assert(self.delegate.isEmailVerified(), 'email must be verified');
    };

    var doSignup = function (emailToken) {
      assert(emailToken, 'email token missing');
      return this._api.POST('signup/trader', {
        email: self.delegate.email(),
        partnerId: self.partnerId,
        defaultCurrency: currencyCode, // ISO 4217
        profile: {
          address: {
            country: countryCode.toUpperCase()
          }
        },
        trustedEmailValidationToken: emailToken,
        generateOfflineToken: true
      });
    };

    var saveMetadata = function (res) {
      this._user = res.trader.id;
      this._offlineToken = res.offlineToken;
      this._api._offlineToken = this._offlineToken;
      return this._delegate.save.bind(this._delegate)().then(function () { return res; });
    };

    return Promise.resolve().then(runChecks.bind(this))
                            .then(this.delegate.getEmailToken.bind(this.delegate))
                            .then(doSignup.bind(this))
                            .then(saveMetadata.bind(this));
  }

  fetchProfile () {
    return this._profile.fetch();
  }

  getBuyQuote (amount, baseCurrency, quoteCurrency) {
    assert(baseCurrency, 'Specify base currency');
    assert(baseCurrency !== 'BTC' || quoteCurrency, 'Specify quote currency');
    if (baseCurrency !== 'BTC') {
      quoteCurrency = 'BTC';
    }
    return Quote.getQuote(this._api, -amount, baseCurrency, quoteCurrency)
                .then(this.setLastQuote.bind(this));
  }

  setLastQuote (quote) {
    this._lastQuote = quote;
    return quote;
  }

  buy (amount, baseCurrency, medium) {
    assert(this.delegate, 'ExchangeDelegate required');
    assert(this._lastQuote !== null, 'You must first obtain a quote');
    assert(this._lastQuote.baseAmount === -amount, 'LAST_QUOTE_AMOUNT_DOES_NOT_MATCH');
    assert(this._lastQuote.baseCurrency === baseCurrency, 'Currency must match last quote');
    assert(this._lastQuote.expiresAt > new Date(), 'LAST_QUOTE_EXPIRED');
    assert(medium === 'bank' || medium === 'card', 'Specify bank or card');

    var addTrade = function (trade) {
      trade.debug = this._debug;
      this._trades.push(trade);
      return this.delegate.save.bind(this.delegate)().then(function () { return trade; });
    };

    return Trade.buy(
      this._lastQuote,
      medium,
      this._api,
      this.delegate,
      this
    ).then(addTrade.bind(this));
  }

  triggerKYC () {
    var addKYC = (kyc) => {
      this._kycs.push(kyc);
      return kyc;
    };

    return CoinifyKYC.trigger(this._api).then(addKYC);
  }

  getKYCs () {
    var save = () => this.delegate.save.bind(this.delegate)().then(() => this._kycs);
    var update = (kycs) => {
      this.updateList(this._kycs, kycs, CoinifyKYC);
    };
    return CoinifyKYC.fetchAll(this._api, this)
                       .then(update)
                       .then(save);
  }

  getBuyMethods () {
    return PaymentMethod.fetchAll(undefined, 'BTC', this._api);
  }

  getSellMethods () {
    return PaymentMethod.fetchAll('BTC', undefined, this._api);
  }

  getBuyCurrencies () {
    var getCurrencies = function (paymentMethods) {
      var currencies = [];
      for (let paymentMethod of paymentMethods) {
        for (let inCurrency of paymentMethod.inCurrencies) {
          if (currencies.indexOf(inCurrency) === -1) {
            currencies.push(inCurrency);
          }
        }
      }
      this._buyCurrencies = JSON.parse(JSON.stringify(currencies));
      return currencies;
    };
    return this.getBuyMethods().then(getCurrencies.bind(this));
  }

  getSellCurrencies () {
    var getCurrencies = function (paymentMethods) {
      var currencies = [];
      for (let paymentMethod of paymentMethods) {
        for (let outCurrency of paymentMethod.outCurrencies) {
          if (currencies.indexOf(outCurrency) === -1) {
            currencies.push(outCurrency);
          }
        }
      }
      this._sellCurrencies = JSON.parse(JSON.stringify(currencies));
      return currencies;
    };
    return this.getSellMethods().then(getCurrencies.bind(this));
  }

  monitorPayments () {
    Trade.monitorPayments(this._trades, this.delegate);
  }

  static new (delegate) {
    assert(delegate, 'Coinify.new requires delegate');
    var object = {
      auto_login: true
    };
    var coinify = new Coinify(object, delegate);
    return coinify;
  }
}

module.exports = Coinify;
