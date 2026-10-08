import { FlowRouter } from 'meteor/kadira:flow-router';
import { BlazeLayout } from 'meteor/kadira:blaze-layout';
import '/imports/ui/layouts/appLayout';
import '/imports/ui/pages/homePage';
import '/imports/ui/pages/listPage';

FlowRouter.route('/', {
  action() {
    BlazeLayout.render('appLayout', { main: 'homePage' });
  },
});

FlowRouter.route('/lists/:listId', {
  action() {
    BlazeLayout.render('appLayout', { main: 'listPage' });
  },
});
