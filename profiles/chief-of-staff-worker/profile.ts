// A worker lane started by chief-of-staff: the default profile, without thread-tools so workers cannot
// thread_send siblings or spawn untracked sub-threads. Coordination goes through the chief of staff.
import { defineProfile } from 'superego'

export default defineProfile({
  extends: 'user:default',
  description: 'Worker lane for chief-of-staff (no peer thread_send)',
  without: ['thread-tools'],
})
