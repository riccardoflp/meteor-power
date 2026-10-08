import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { TASKS } from '/imports/api/tasks/names';
import './taskItem.html';

Template.taskItem.helpers({
  timeAgo(date) {
    const minutes = Math.round((Date.now() - date) / 60000);
    return minutes < 60 ? `${minutes} min ago` : date.toLocaleDateString();
  },
});

Template.taskItem.events({
  async 'click .js-toggle'(event) {
    await Meteor.callAsync('tasks.setChecked', this.task._id, event.target.checked);
  },

  async 'click .js-delete'() {
    await Meteor.callAsync(TASKS.REMOVE, this.task._id);
  },
});
