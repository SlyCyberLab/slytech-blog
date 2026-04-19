import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string(),
    category: z.enum(['detection', 'compliance', 'homelab', 'cloud', 'iam', 'career']),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { blog };
