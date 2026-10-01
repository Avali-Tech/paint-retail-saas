// Response shapes of the API routes the web app uses, shared with apps/api
// through @paint/shared so the two cannot drift apart.

export type {
  AuthProfile as Profile,
  BrandingSaved,
  BrandingView,
  Dashboard,
  NotificationView as Notification,
  NotificationPage,
  SearchHit,
  SearchResults,
  SessionGrant,
  StageCount,
  StorePosition,
} from '@paint/shared';
