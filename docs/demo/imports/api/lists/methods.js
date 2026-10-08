import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { ValidatedMethod } from 'meteor/mdg:validated-method';

export const ListsCollection = new Mongo.Collection('lists');

/** Creates a new list owned by the current user. */
export const createList = new ValidatedMethod({
  name: 'lists.create',
  validate: null,
  async run({ name }) {
    return ListsCollection.insertAsync({ name, owner: this.userId, createdAt: new Date() });
  },
});

export const renameList = new ValidatedMethod({
  name: 'lists.rename',
  validate: null,
  async run({ listId, name }) {
    await ListsCollection.updateAsync(listId, { $set: { name } });
  },
});

if (Meteor.isServer) {
  Meteor.publish('lists.all', function () {
    return ListsCollection.find({ owner: this.userId });
  });
}
