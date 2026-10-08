import { debounce } from 'lodash';
import { insertTask } from '/imports/api/tasks/tasks';
import { insertTask as addTask } from '../imports/api/tasks/tasks';
import * as Tasks from '/imports/api/tasks/tasks';

export async function addAll() {
  insertTask.call({ text: 'a' });
  await Tasks.insertTask.callAsync({ text: 'b' });
  addTask.call({ text: 'c' }, () => {});
  await Meteor.callAsync(insertTask.name, { text: 'd' });
  // not a method object
  debounce.call(null, () => {});
}
