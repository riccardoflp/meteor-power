import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { PAGE } from '../imports/names';

Template.layout.helpers({
  title() {
    return 'Admin';
  },
});

Meteor.callAsync('common.ping');
Meteor.callAsync('admin.purge');
Meteor.callAsync('audit.log');
Meteor.callAsync('logger.write');
Meteor.callAsync('web.signup');
Meteor.callAsync(PAGE.HOME);
