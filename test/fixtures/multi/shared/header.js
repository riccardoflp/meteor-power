import { Template } from 'meteor/templating';

Template.header.helpers({
  appName() {
    return 'Meteor';
  },
});
