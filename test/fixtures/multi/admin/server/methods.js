import { Meteor } from 'meteor/meteor';
import { PAGE } from '../imports/names';

Meteor.methods({
  'admin.purge'() {},
  'common.ping'() {},
  [PAGE.HOME]() {},
});
