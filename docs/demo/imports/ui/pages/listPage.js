import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { FlowRouter } from 'meteor/kadira:flow-router';
import { TasksCollection } from '/imports/api/tasks/collection';
import { ListsCollection } from '/imports/api/lists/methods';
import { TASKS } from '/imports/api/tasks/names';
import '../components/taskItem';
import '../components/loading.html';
import './listPage.html';

Template.listPage.onCreated(function () {
  this.listId = () => FlowRouter.getParam('listId');
  this.autorun(() => {
    this.subscribe('lists.all');
    this.subscribe('tasks.byList', this.listId());
  });
});

Template.listPage.helpers({
  list() {
    return ListsCollection.findOne(Template.instance().listId());
  },
  tasks() {
    return TasksCollection.find({ listId: Template.instance().listId() }, { sort: { createdAt: -1 } });
  },
  remainingCount() {
    return TasksCollection.find({ listId: Template.instance().listId(), checked: { $ne: true } }).count();
  },
});

Template.listPage.events({
  async 'submit .js-new-task'(event, instance) {
    event.preventDefault();
    const input = event.target.text;
    await Meteor.callAsync(TASKS.INSERT, instance.listId(), input.value);
    input.value = '';
  },
});
