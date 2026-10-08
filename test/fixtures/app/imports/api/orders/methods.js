import { Meteor } from 'meteor/meteor';
import { createMethod, defineMethods, Method, createPublication } from '/imports/lib/methods';
import ORDERS from './names';

createMethod('orders.create', async function (order) {
  return order;
});

createMethod({
  name: ORDERS.CANCEL,
  async run({ orderId }) {
    return orderId;
  },
});

defineMethods({
  'orders.archive'(id) {},
});

new Method('orders.restore', {
  run(id) {},
});

Meteor.methods({
  [ORDERS.SHIP](orderId, carrier) {},
});

createPublication('orders.mine', function () {
  return [];
});
