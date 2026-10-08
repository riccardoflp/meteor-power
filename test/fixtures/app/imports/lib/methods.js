import { Meteor } from 'meteor/meteor';

// Project wrappers around the Meteor APIs (configured in .vscode/settings.json)
export function createMethod(nameOrOptions, handler) {
  const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name;
  Meteor.methods({ [name]: handler ?? nameOrOptions.run });
}

export function defineMethods(map) {
  Meteor.methods(map);
}

export class Method {
  constructor(name, options) {
    Meteor.methods({ [name]: options.run });
  }
}

export const callMethod = (name, ...args) => Meteor.callAsync(name, ...args);

export function createPublication(name, fn) {
  Meteor.publish(name, fn);
}

export const useSubscribe = (name) => Meteor.subscribe(name);
