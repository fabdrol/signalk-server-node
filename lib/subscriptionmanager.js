/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const _ = require('lodash')
const Bacon = require('baconjs')
const geolib = require('geolib')
const debug = require('debug')('signalk-server:subscriptionmanager')
const { toDelta } = require('./streambundle')

function SubscriptionManager (app) {
  this.streambundle = app.streambundle
  this.selfContext = app.selfContext
  this.app = app
}

SubscriptionManager.prototype.subscribe = function (
  command,
  unsubscribes,
  errorCallback,
  callback,
  user
) {
  const contextFilter = contextMatcher(
    this.selfContext,
    this.app,
    command,
    errorCallback,
    user
  )
  if (Array.isArray(command.subscribe)) {
    handleSubscribeRows(
      this.app,
      command.subscribe,
      unsubscribes,
      this.streambundle.buses,
      contextFilter,
      callback,
      errorCallback,
      user
    )
    // listen to new keys and then use the same logic to check if we
    // want to subscribe, passing in a map with just that single bus
    unsubscribes.push(
      this.streambundle.keys.onValue(key => {
        const buses = {}
        buses[key] = this.streambundle.getBus(key)
        handleSubscribeRows(
          this.app,
          command.subscribe,
          unsubscribes,
          buses,
          contextFilter,
          callback,
          errorCallback,
          user
        )
      })
    )
  }
}

function handleSubscribeRows (
  app,
  rows,
  unsubscribes,
  buses,
  filter,
  callback,
  errorCallback,
  user
) {
  rows.reduce((acc, subscribeRow) => {
    if (subscribeRow.path) {
      handleSubscribeRow(
        app,
        subscribeRow,
        unsubscribes,
        buses,
        filter,
        callback,
        errorCallback,
        user
      )
    }
    return acc
  }, unsubscribes)
}

function handleSubscribeRow (
  app,
  subscribeRow,
  unsubscribes,
  buses,
  filter,
  callback,
  errorCallback,
  user
) {
  const matcher = pathMatcher(subscribeRow.path)
  // iterate over all the buses, checking if we want to subscribe to its values
  _.forOwn(buses, (bus, key) => {
    if (matcher(key)) {
      debug('Subscribing to key ' + key)
      let filteredBus = bus.filter(filter)
      if (subscribeRow.minPeriod) {
        if (subscribeRow.policy && subscribeRow.policy != 'instant') {
          errorCallback(
            "minPeriod assumes policy 'instant', ignoring policy " +
              subscribeRow.policy
          )
        }
        debug('minPeriod:' + subscribeRow.minPeriod)
        filteredBus = filteredBus.debounceImmediate(subscribeRow.minPeriod)
      } else if (
        subscribeRow.period ||
        (subscribeRow.policy && subscribeRow.policy === 'fixed')
      ) {
        if (subscribeRow.policy && subscribeRow.policy != 'fixed') {
          errorCallback(
            "period assumes policy 'fixed', ignoring policy " +
              subscribeRow.policy
          )
        } else {
          const interval = subscribeRow.period || 1000
          filteredBus = filteredBus
            .bufferWithTime(interval)
            .flatMapLatest(bufferedValues => {
              const uniqueValues = _(bufferedValues)
                .reverse()
                .uniqBy(
                  value =>
                    value.context + ':' + value.$source + ':' + value.path
                )
                .value()
              return Bacon.fromArray(uniqueValues)
            })
        }
      }
      if (subscribeRow.format && subscribeRow.format != 'delta') {
        errorCallback('Only delta format supported, using it')
      }
      if (
        subscribeRow.policy &&
        !['instant', 'fixed'].some(s => s === subscribeRow.policy)
      ) {
        errorCallback(
          "Only 'instant' and 'fixed' policies supported, ignoring policy " +
            subscribeRow.policy
        )
      }
      unsubscribes.push(filteredBus.map(toDelta).onValue(callback))

      const latest = app.deltaCache.getCachedDeltas(user, filter, key)
      if (latest) {
        latest.forEach(callback)
      }
    }
  })
}

function pathMatcher (path) {
  const pattern = path.replace('.', '\\.').replace('*', '.*')
  const matcher = new RegExp('^' + pattern + '$')
  return aPath => matcher.test(aPath)
}

function contextMatcher (selfContext, app, subscribeCommand, errorCallback) {
  debug('subscribeCommand:' + JSON.stringify(subscribeCommand))
  if (subscribeCommand.context) {
    if (_.isString(subscribeCommand.context)) {
      const pattern = subscribeCommand.context
        .replace('.', '\\.')
        .replace('*', '.*')
      const matcher = new RegExp('^' + pattern + '$')
      return normalizedDeltaData =>
        matcher.test(normalizedDeltaData.context) ||
        ((subscribeCommand.context === 'vessels.self' ||
          subscribeCommand.context === 'self') &&
          normalizedDeltaData.context === selfContext)
    } else if (_.get(subscribeCommand.context, 'radius')) {
      if (
        !_.get(subscribeCommand.context, 'radius') ||
        !_.get(subscribeCommand.context, 'position.latitude') ||
        !_.get(subscribeCommand.context, 'position.longitude')
      ) {
        errorCallback(
          'Please specify a radius and position for relativePosition'
        )
        return x => false
      }
      return normalizedDeltaData => {
        return checkPosition(app, subscribeCommand.context, normalizedDeltaData)
      }
    }
  }
  return x => true
}

function checkPosition (app, context, normalizedDeltaData) {
  const vessel = _.get(app.signalk.root, normalizedDeltaData.context)
  const position = _.get(vessel, 'navigation.position')

  const subsPosition = _.get(context, 'position')
  if (
    position &&
    subsPosition &&
    subsPosition.latitude &&
    subsPosition.longitude
  ) {
    return geolib.isPointInCircle(position.value, subsPosition, context.radius)
  }

  return false
}

module.exports = SubscriptionManager
