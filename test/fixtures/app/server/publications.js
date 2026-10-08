import { Meteor } from 'meteor/meteor';
import { PUB_USERS_ONE } from '../imports/api/users/constants';

Meteor.publish('users.list', function (limit) {
  return Meteor.users.find({}, { limit });
});

Meteor.publish({
  [PUB_USERS_ONE](id) {
    return Meteor.users.find(id);
  },
});

Meteor.publish(null, function () {
  return null;
});
