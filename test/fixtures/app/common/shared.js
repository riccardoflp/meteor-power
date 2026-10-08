import { Meteor } from 'meteor/meteor';

Meteor.publish('shared.items', function () {
  return [];
});

Meteor.methods({
  'shared.ping'() {
    return 'pong';
  },
});
