import { Template } from 'meteor/templating';
import './card.html';

Template.baseCard.helpers({
  title() {
    return Template.currentData().list?.name ?? 'Untitled';
  },
});

Template.listCard.helpers({
  taskCount() {
    return this.list.taskCount ?? 0;
  },
});

// aldeed:template-extension
Template.listCard.inheritsHelpersFrom('baseCard');
