import { Template } from 'meteor/templating';
import './cards.html';

Template.baseCard.helpers({
  title() {
    return 'Card';
  },
});

Template.baseCard.events({
  'click .js-open'() {},
});

Template.fancyCard.helpers({
  subtitle() {
    return 'Fancy';
  },
});

// aldeed:template-extension
Template.fancyCard.inheritsHelpersFrom('baseCard');
Template.fancyCard.inheritsEventsFrom(['baseCard']);
Template.baseCard.copyAs('plainCard');
