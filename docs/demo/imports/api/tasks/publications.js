import { Meteor } from 'meteor/meteor';
import { TasksCollection } from './collection';

Meteor.publish('tasks.byList', function (listId) {
  return TasksCollection.find({ listId, owner: this.userId });
});

Meteor.publish('tasks.mine', function () {
  return TasksCollection.find({ owner: this.userId, checked: { $ne: true } });
});
