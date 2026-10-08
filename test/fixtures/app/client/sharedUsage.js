import { Meteor } from 'meteor/meteor';

Meteor.subscribe('shared.items');
Meteor.callAsync('shared.ping');
