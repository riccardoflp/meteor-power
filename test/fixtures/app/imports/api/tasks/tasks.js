import { Meteor } from 'meteor/meteor';
import { ValidatedMethod } from 'meteor/mdg:validated-method';

export const insertTask = new ValidatedMethod({
  name: 'tasks.insert',
  validate: null,
  async run({ text }) {
    return text;
  },
});

const taskMethods = {
  'tasks.toggle'(taskId, checked) {},
};

if (Meteor.isServer) {
  Meteor.methods(taskMethods);
  Meteor.methods({
    'tasks.serverOnly'() {},
    ping() {},
  });
}
