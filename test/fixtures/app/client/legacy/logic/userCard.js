import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';

Template.userCard.onCreated(function () {
  this.subscribe('users.list', 10);
  this.subscribe('users.unknownPub');
});

Template.userCard.helpers({
  fullName() {
    return 'Mario Rossi';
  },
  items: () => [],
  selected() {
    return false;
  },
});

Template.userCard.events({
  async 'click .js-save, submit #card-main'(event, instance) {
    await Meteor.callAsync('users.update', Meteor.userId(), {});
    Meteor.call('users.typo');
  },
});
