import { listPolicies } from '../docker.js';

export default async function policyRoutes(fastify) {
  fastify.get('/api/policies', async () => {
    return listPolicies();
  });
}
