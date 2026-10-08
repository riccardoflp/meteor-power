import { Template } from 'meteor/templating';
import { ListsCollection, createList } from '/imports/api/lists/methods';
import '../components/card';
import './homePage.html';

Template.homePage.onCreated(function () {
  this.subscribe('lists.all');
});

Template.homePage.helpers({
  lists() {
    return ListsCollection.find({}, { sort: { createdAt: -1 } });
  },
});

Template.homePage.events({
  async 'click .js-new-list'() {
    await createList.callAsync({ name: 'New list' });
  },
});
