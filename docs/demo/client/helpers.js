import { Template } from 'meteor/templating';

Template.registerHelper('formatDate', (date) => date?.toLocaleDateString());

Template.registerHelper('currentUserName', () => Meteor.user()?.profile?.name);
