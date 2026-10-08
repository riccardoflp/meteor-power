import { Meteor } from 'meteor/meteor';

Meteor.methods({
  async 'users.profile.update'(profile) {
    await Meteor.users.updateAsync(this.userId, { $set: { profile } });
  },

  async 'users.profile.setAvatar'(url) {
    await Meteor.users.updateAsync(this.userId, { $set: { 'profile.avatar': url } });
  },

  async 'users.preferences.save'(prefs) {
    await Meteor.users.updateAsync(this.userId, { $set: { prefs } });
  },
});
