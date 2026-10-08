import { Meteor } from 'meteor/meteor';
import { callMethod, useSubscribe } from '/imports/lib/methods';
import { USERS_METHODS as UM } from '/imports/api/users/constants';
import OrderNames from '../imports/api/orders/names.js';

const { RESET } = UM;
const Api = { callMethod };

export async function placeOrder(order) {
  await callMethod('orders.create', order);
  await Api.callMethod({ name: OrderNames.CANCEL, orderId: 1 });
  await Meteor.callAsync(UM.RESET);
  await Meteor.callAsync(RESET);
  await Meteor.callAsync(OrderNames.SHIP, 1, 'ups');
  useSubscribe('orders.mine');
}
