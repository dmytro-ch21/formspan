import { render, screen } from '@testing-library/react-native';

import { BeltPhoto } from '../BeltPhoto';

/**
 * Which number the belt is drawing, and that it reaches the drawing at all.
 *
 * `lib/__tests__/beltBar.test.ts` covers the geometry thoroughly, and covers it
 * in isolation — swap `degree` and `stripes` at the one line in `BeltPhoto`
 * that chooses between them and every one of those assertions still passes,
 * because the pure function was never given the wrong argument. A coloured belt
 * would then draw its owner's black-belt degrees and a black belt its stripes,
 * which for most athletes is zero of both and therefore silent.
 *
 * So this covers the wiring only: the branch, and that the polygons are really
 * mounted rather than computed and dropped.
 */

const stripes = () => screen.UNSAFE_root.findAllByType('RNSVGPath' as never);

describe('BeltPhoto', () => {
  it('draws stripes for a coloured belt and ignores its degree', () => {
    render(<BeltPhoto belt="purple" stripes={3} degree={5} width={215} label="Purple belt" />);
    expect(stripes()).toHaveLength(3);
  });

  it('draws degrees for a black belt and ignores its stripes', () => {
    // The one that matters: a black belt's `stripes` is 0 by convention, so
    // reading the wrong field draws nothing at all and looks like a plain belt.
    render(<BeltPhoto belt="black" stripes={0} degree={4} width={215} label="Black belt" />);
    expect(stripes()).toHaveLength(4);
  });

  it('draws a bare belt at zero', () => {
    render(<BeltPhoto belt="white" stripes={0} degree={0} width={215} label="White belt" />);
    expect(stripes()).toHaveLength(0);
  });

  it('is one image to a screen reader, not a belt plus some shapes', () => {
    render(<BeltPhoto belt="blue" stripes={2} degree={0} width={215} label="Blue belt, 2 stripes" />);
    expect(screen.getByLabelText('Blue belt, 2 stripes')).toBeTruthy();
  });
});
