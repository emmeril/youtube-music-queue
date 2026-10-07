'use strict';

const ADMIN_PRIORITY_LIMIT = 3;

function getPriorityStatus(role, queue) {
  const priorityCount = Array.isArray(queue)
    ? queue.filter((request) => Boolean(request?.isPriority)).length
    : 0;
  const limit = role === 'admin' ? ADMIN_PRIORITY_LIMIT : null;

  return {
    allowed: limit === null || priorityCount < limit,
    priorityCount,
    limit
  };
}

module.exports = {
  ADMIN_PRIORITY_LIMIT,
  getPriorityStatus
};
