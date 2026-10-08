import { Meteor } from 'meteor/meteor';

Meteor.methods({
  'shared.save'(doc) {},
});

export async function ping() {
  await Meteor.callAsync('common.ping');
  await Meteor.callAsync('admin.purge');
}
