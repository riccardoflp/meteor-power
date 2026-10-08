import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { USERS_METHODS } from './constants';

Meteor.methods({
  /**
   * Updates the user profile.
   * @param {string} userId
   */
  'users.update': async function (userId, data) {
    check(userId, String);
    return Meteor.users.updateAsync(userId, { $set: data });
  },

  async 'users.remove'(id) {
    await Meteor.callAsync('users.reset', id);
    return Meteor.users.removeAsync(id);
  },

  [USERS_METHODS.RESET]: async (id, { force = false } = {}) => {
    return true;
  },

  [USERS_METHODS.PROFILE.SAVE](profile) {
    return profile;
  },
});
