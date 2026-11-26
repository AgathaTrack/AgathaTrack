import { DEMO_IDS, DEMO_USERS } from '../demo-constants.js';
import { calendarDaysFromToday, upsertPersonalPet, upsertUser } from '../helpers.js';

export async function seedGuardian(client) {
  await upsertUser(client, DEMO_USERS.alice);
  await upsertUser(client, DEMO_USERS.carol);

  await upsertPersonalPet(client, {
    id: DEMO_IDS.buddyPet,
    userId: DEMO_IDS.alice,
    name: 'Buddy',
    species: 'Dog',
    breed: 'Labrador Retriever',
    dateOfBirth: calendarDaysFromToday(-365 * 4),
    weight: 28.5,
    gender: 'Male',
    bio: 'Friendly family dog — demo guardian pet with rich health history',
  });

  await upsertPersonalPet(client, {
    id: DEMO_IDS.whiskersPet,
    userId: DEMO_IDS.alice,
    name: 'Whiskers',
    species: 'Cat',
    breed: 'Domestic Shorthair',
    dateOfBirth: calendarDaysFromToday(-365 * 3),
    weight: 4.2,
    gender: 'Female',
    bio: 'Indoor cat with regular vet visits',
  });

  await upsertPersonalPet(client, {
    id: DEMO_IDS.maxPet,
    userId: DEMO_IDS.alice,
    name: 'Max',
    species: 'Dog',
    breed: 'Mixed breed',
    dateOfBirth: calendarDaysFromToday(-365 * 2),
    weight: 12.0,
    gender: 'Male',
    bio: 'Young dog — flea prevention care item demo',
  });

  console.log(
    'seed: guardian scenario ready (Frederique, Carol, Buddy, Whiskers, Max)',
  );
}
