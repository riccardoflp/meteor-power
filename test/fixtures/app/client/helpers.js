import { Template } from 'meteor/templating';

Template.registerHelper('formatDate', (date, format) => String(date));
Template.registerHelper('emptyText', () => 'Nessun elemento');
