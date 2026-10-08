import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { PAGE } from '../imports/names';

Template.layout.helpers({
  title() {
    return 'Web';
  },
});

Meteor.callAsync('common.ping');
Meteor.callAsync('web.signup');
Meteor.callAsync('audit.log');
Meteor.callAsync(PAGE.HOME);
