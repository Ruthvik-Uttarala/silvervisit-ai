import { loadConfig } from "../src/config";
import { getFirestoreRepository } from "../src/firestore";

async function main(): Promise<void> {
  const config = loadConfig();
  const repository = getFirestoreRepository(config);
  const diagnostics = repository.getDiagnostics();
  if (!diagnostics.configured) {
    throw new Error(
      "Firestore is not configured. Set ENABLE_FIRESTORE=true and either FIRESTORE_EMULATOR_HOST or GOOGLE_CLOUD_PROJECT.",
    );
  }

  const seeded = await repository.ensureDeterministicFixtures();
  const fixtures = await repository.listFixtures();
  console.log(
    JSON.stringify(
      {
        ok: true,
        firestoreMode: diagnostics.mode,
        seededCount: seeded,
        fixtures: fixtures.map((fixture) => ({
          seed: fixture.seed,
          fixtureId: fixture.fixtureId,
          patientName: fixture.patientName,
          doctorName: fixture.doctorName,
          appointmentType: fixture.appointmentType,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
