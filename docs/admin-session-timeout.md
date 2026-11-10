# Admin session timeout

The fixed twenty-minute login policy has been replaced by activity-based admin
sessions: 30 minutes of inactivity, an eight-hour maximum lifetime, and a
warning two minutes before expiry.

See [Admin sessions](admin-sessions.md) for the current server policy, UI behavior,
verification commands and rollout instructions. Deploy the backend before the
frontend, close together; existing admins must sign in once after deployment.
Customer sessions retain their existing 30-day policy.
