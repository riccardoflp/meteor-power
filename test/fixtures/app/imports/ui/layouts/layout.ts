import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';
import * as C from '../../api/users/constants';

Template.navbar.helpers({
  title(): string {
    return 'App';
  },
});

Template.navbar.events({
  async 'click nav'(event: Event) {
    const ok = await Meteor.callAsync(C.USERS_METHODS.RESET, 'id' as string);
    await Meteor.callAsync(`users.profile.save`, {});
  },
});
