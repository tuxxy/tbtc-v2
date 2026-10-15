import Mathlib.AlgebraicGeometry.EllipticCurve.Jacobian.Point
import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Ring

/-!
Partial C-07 arithmetic correspondence: ordinary non-infinite Jacobian doubling.
These lemmas quantify over fields; they are not finite vector checks.
Infinity/equal/inverse branches, scalar composition, uint256/source semantics,
lift/hash parsing and the two named verifier predicates remain separate duties.
-/
namespace FrostC07

variable {F : Type} [Field F]

def doubleD (x y : F) : F :=
  2 * ((x + y * y) * (x + y * y) - x * x - (y * y) * (y * y))

def doubleX (x y : F) : F :=
  (3 * (x * x)) * (3 * (x * x)) - 2 * doubleD x y

def doubleY (x y : F) : F :=
  (3 * (x * x)) * (doubleD x y - doubleX x y) - 8 * ((y * y) * (y * y))

def doubleZ (y z : F) : F := 2 * (y * z)

theorem doubleD_identity (x y : F) : doubleD x y = 4 * x * y ^ 2 := by
  unfold doubleD
  ring

theorem doubleX_affine (x y z : F) (hy : y ≠ 0) (hz : z ≠ 0)
    (h2 : (2 : F) ≠ 0) :
    doubleX x y / (doubleZ y z) ^ 2 =
      (3 * (x / z ^ 2) ^ 2 / (2 * (y / z ^ 3))) ^ 2 - 2 * (x / z ^ 2) := by
  unfold doubleX doubleD doubleZ
  field_simp [hy, hz, h2]
  ring

theorem doubleSlope_affine (x y z : F) (hy : y ≠ 0) (hz : z ≠ 0)
    (h2 : (2 : F) ≠ 0) :
    3 * (x / z ^ 2) ^ 2 / (2 * (y / z ^ 3)) = 3 * x ^ 2 / (2 * y * z) := by
  field_simp [hy, hz, h2]
  ring

theorem doubleY_affine (x y z : F) (hy : y ≠ 0) (hz : z ≠ 0)
    (h2 : (2 : F) ≠ 0) :
    doubleY x y / (doubleZ y z) ^ 3 =
      (3 * (x / z ^ 2) ^ 2 / (2 * (y / z ^ 3))) *
        (x / z ^ 2 - ((3 * (x / z ^ 2) ^ 2 / (2 * (y / z ^ 3))) ^ 2 - 2 * (x / z ^ 2)))
      - y / z ^ 3 := by
  have h8 : (8 : F) ≠ 0 := by
    convert pow_ne_zero 3 h2 using 1 <;> norm_num
  rw [doubleSlope_affine x y z hy hz h2]
  unfold doubleY doubleX doubleD doubleZ
  field_simp [hy, hz, h2, h8]
  ring_nf
  field_simp [hy, hz, h2, h8]
  ring

/-- The short Weierstrass equation underlying secp256k1, over a generic field.
This definition does not establish primality, curve order or Solidity binding. -/
def shortCurve (F : Type) [Field F] : WeierstrassCurve.Jacobian F :=
  ⟨0, 0, 0, 0, 7⟩

theorem ne_neg_of_two_ne_zero (v : F) (hv : v ≠ 0) (h2 : (2 : F) ≠ 0) :
    v ≠ -v := by
  intro heq
  have hzero : (2 : F) * v = 0 := by
    calc
      (2 : F) * v = v + v := by ring
      _ = -v + v := congrArg (fun t => t + v) heq
      _ = 0 := neg_add_cancel v
  exact mul_ne_zero h2 hv hzero

theorem shortCurve_slope_self (u v : F) (hv : v ≠ 0) (h2 : (2 : F) ≠ 0) :
    (shortCurve F).toAffine.slope u u v v = 3 * u ^ 2 / (2 * v) := by
  have hneg := ne_neg_of_two_ne_zero v hv h2
  simp [WeierstrassCurve.Affine.slope, WeierstrassCurve.Affine.negY,
    shortCurve, hneg, ← two_mul]

/-- Ordinary doubling has the same normalized X/Y coordinates as mathlib's
Jacobian doubling on the short curve. Infinity and Y=0 branches are excluded
explicitly. This is arithmetic correspondence, not a verifier predicate. -/
theorem ordinary_double_mathlib (x y z : F) (hy : y ≠ 0) (hz : z ≠ 0)
    (h2 : (2 : F) ≠ 0)
    (hEq : (shortCurve F).Equation ![x, y, z]) :
    doubleX x y / doubleZ y z ^ 2 =
      (shortCurve F).dblX ![x, y, z] / (shortCurve F).dblZ ![x, y, z] ^ 2 ∧
    doubleY x y / doubleZ y z ^ 3 =
      (shortCurve F).dblY ![x, y, z] / (shortCurve F).dblZ ![x, y, z] ^ 3 := by
  have hnot : ![x, y, z] 1 * ![x, y, z] 2 ^ 3 ≠
      (shortCurve F).negY ![x, y, z] * ![x, y, z] 2 ^ 3 := by
    simpa [shortCurve, WeierstrassCurve.Jacobian.negY] using
      ne_neg_of_two_ne_zero (y * z ^ 3) (mul_ne_zero hy (pow_ne_zero 3 hz)) h2
  have hx := WeierstrassCurve.Jacobian.dblX_of_Z_ne_zero
    hEq hEq hz hz (Eq.refl _) hnot
  have hy' := WeierstrassCurve.Jacobian.dblY_of_Z_ne_zero
    hEq hEq hz hz (Eq.refl _) hnot
  have hs := shortCurve_slope_self (x / z ^ 2) (y / z ^ 3)
    (div_ne_zero hy (pow_ne_zero 3 hz)) h2
  constructor
  · rw [hx, doubleX_affine x y z hy hz h2]
    simp only [Matrix.cons_val_zero, Matrix.cons_val_one, Matrix.cons_val_two,
      Matrix.head_cons, Matrix.tail_cons]
    rw [hs]
    simp [shortCurve, WeierstrassCurve.Affine.addX]
    ring
  · rw [hy', doubleY_affine x y z hy hz h2]
    simp only [Matrix.cons_val_zero, Matrix.cons_val_one, Matrix.cons_val_two,
      Matrix.head_cons, Matrix.tail_cons]
    rw [hs]
    simp [shortCurve, WeierstrassCurve.Affine.addY,
      WeierstrassCurve.Affine.negAddY, WeierstrassCurve.Affine.negY,
      WeierstrassCurve.Affine.addX]
    ring

#print axioms doubleD_identity
#print axioms doubleX_affine
#print axioms doubleSlope_affine
#print axioms doubleY_affine
#print axioms ordinary_double_mathlib

end FrostC07
