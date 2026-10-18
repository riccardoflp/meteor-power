let Meteor; module.link('meteor/meteor', { Meteor(v) { Meteor = v; } }, 0);
Meteor.methods({
  'example.performTask': async function (input) {
    return input;
  },
  'example.v1only'() {},
});
Meteor.call('example.internalUnknown');
