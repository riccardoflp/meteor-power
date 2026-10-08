import { FlowRouter } from 'meteor/ostrio:flow-router-extra';
import { BlazeLayout } from 'meteor/pwix:blaze-layout';

FlowRouter.route('/users', {
  action() {
    BlazeLayout.render('mainLayout', { main: 'userCard' });
  },
});
