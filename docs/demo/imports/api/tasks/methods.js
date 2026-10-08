import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { TasksCollection } from './collection';
import { TASKS } from './names';

Meteor.methods({
  /**
   * Adds a task to a list.
   * @param {string} listId
   * @param {string} text
   */
  async [TASKS.INSERT](listId, text) {
    check(text, String);
    return TasksCollection.insertAsync({ listId, text, owner: this.userId, createdAt: new Date() });
  },

  /** Marks a task as done, or not done. */
  async [TASKS.SET_CHECKED](taskId, checked) {
    check(checked, Boolean);
    await TasksCollection.updateAsync(taskId, { $set: { checked } });
  },

  /** Deletes a task. Only the owner can do it. */
  async [TASKS.REMOVE](taskId) {
    await TasksCollection.removeAsync({ _id: taskId, owner: this.userId });
  },
});
