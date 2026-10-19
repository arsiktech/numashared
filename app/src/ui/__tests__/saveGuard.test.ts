// Review blocker 6: the sheet's closing animation remounts its content. The Save guard must
// survive that, or a second tap during dismissal saves the expense twice.
import { expect, test } from 'vitest';
import { saveGuard } from '../saveGuard';

test('a Save guard outlives the component that set it', () => {
  const firstMount = saveGuard(41);
  expect(firstMount.current).toBe(false);
  firstMount.current = true;
  // The remounted body asks again with the same sheet key.
  const secondMount = saveGuard(41);
  expect(secondMount.current).toBe(true);
  // Another sheet is not affected, and a failed save releases the guard.
  expect(saveGuard(42).current).toBe(false);
  secondMount.current = false;
  expect(saveGuard(41).current).toBe(false);
});
