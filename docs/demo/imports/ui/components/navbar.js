import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import './navbar.html';

Template.navbar.events({
  'click .js-logout'() {
    Meteor.logout();
  },
});
