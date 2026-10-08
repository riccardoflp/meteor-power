import { Meteor } from 'meteor/meteor';
import { PAGE } from '../imports/names';

Meteor.methods({
  'web.signup'(email) {},
  'common.ping'() {},
  [PAGE.HOME]() {},
});
