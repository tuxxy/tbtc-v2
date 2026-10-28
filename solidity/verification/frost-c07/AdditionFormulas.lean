import Mathlib.AlgebraicGeometry.EllipticCurve.Jacobian.Point
import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Ring

/-!
Ordinary distinct-projective-X branch of FrostSecp256k1.add. The definitions
below preserve its U1/U2/S1/S2/H/I/J/R/V and output expression ordering over a
field. Powers 2/3 abbreviate the source's repeated multiplications. This is not
a theorem about uint256, addmod/mulmod or the exceptional source branches.
-/
namespace FrostC07.Addition

variable {F : Type} [Field F]

def h (u1 u2 : F) : F := u2 - u1
def i (u1 u2 : F) : F := (2 * h u1 u2) * (2 * h u1 u2)
def j (u1 u2 : F) : F := h u1 u2 * i u1 u2
def r (s1 s2 : F) : F := 2 * (s2 - s1)
def v (u1 u2 : F) : F := u1 * i u1 u2

def coreX (u1 u2 s1 s2 : F) : F :=
  r s1 s2 * r s1 s2 - j u1 u2 - 2 * v u1 u2
def coreY (u1 u2 s1 s2 : F) : F :=
  r s1 s2 * (v u1 u2 - coreX u1 u2 s1 s2) - 2 * (s1 * j u1 u2)

def u1 (P Q : Fin 3 → F) : F := P 0 * Q 2 ^ 2
def u2 (P Q : Fin 3 → F) : F := Q 0 * P 2 ^ 2
def s1 (P Q : Fin 3 → F) : F := P 1 * Q 2 ^ 3
def s2 (P Q : Fin 3 → F) : F := Q 1 * P 2 ^ 3

def sourceX (P Q : Fin 3 → F) : F := coreX (u1 P Q) (u2 P Q) (s1 P Q) (s2 P Q)
def sourceY (P Q : Fin 3 → F) : F := coreY (u1 P Q) (u2 P Q) (s1 P Q) (s2 P Q)
def sourceZ (P Q : Fin 3 → F) : F :=
  ((P 2 + Q 2) * (P 2 + Q 2) - P 2 * P 2 - Q 2 * Q 2) * h (u1 P Q) (u2 P Q)

theorem sourceZ_identity (P Q : Fin 3 → F) :
    sourceZ P Q = 2 * (P 2 * Q 2) * h (u1 P Q) (u2 P Q) := by
  unfold sourceZ
  ring

theorem coreX_affine (u1 u2 s1 s2 c : F) (hc : c ≠ 0)
    (hh : h u1 u2 ≠ 0) (h2 : (2 : F) ≠ 0) :
    coreX u1 u2 s1 s2 / (2 * c * h u1 u2) ^ 2 =
      ((s2 - s1) / (c * h u1 u2)) ^ 2 - u1 / c ^ 2 - u2 / c ^ 2 := by
  unfold coreX r j v i
  field_simp [hc, hh, h2]
  unfold h
  ring

theorem normalizeY (u s H R X c : F) (hc : c ≠ 0) (hh : H ≠ 0)
    (h2 : (2 : F) ≠ 0) :
    (R * (u * ((2 * H) * (2 * H)) - X) -
      2 * (s * (H * ((2 * H) * (2 * H))))) / (2 * c * H) ^ 3 =
      (R / (2 * c * H)) * (u / c ^ 2 - X / (2 * c * H) ^ 2) - s / c ^ 3 := by
  have h4 : (4 : F) ≠ 0 := by
    convert pow_ne_zero 2 h2 using 1 <;> norm_num
  have h8 : (8 : F) ≠ 0 := by
    convert pow_ne_zero 3 h2 using 1 <;> norm_num
  field_simp [hc, hh, h2, h4, h8]
  ring_nf
  field_simp [hc, hh, h2, h4, h8]
  ring

theorem coreY_affine (u1 u2 s1 s2 c : F) (hc : c ≠ 0)
    (hh : h u1 u2 ≠ 0) (h2 : (2 : F) ≠ 0) :
    coreY u1 u2 s1 s2 / (2 * c * h u1 u2) ^ 3 =
      ((s2 - s1) / (c * h u1 u2)) *
        (u1 / c ^ 2 - coreX u1 u2 s1 s2 / (2 * c * h u1 u2) ^ 2) -
      s1 / c ^ 3 := by
  have slope : r s1 s2 / (2 * c * h u1 u2) =
      (s2 - s1) / (c * h u1 u2) := by
    unfold r
    field_simp [hc, hh, h2]
    ring
  rw [← slope]
  unfold coreY v j i
  exact normalizeY u1 s1 (h u1 u2) (r s1 s2) (coreX u1 u2 s1 s2) c hc hh h2

def curve (F : Type) [Field F] : WeierstrassCurve.Jacobian F := ⟨0, 0, 0, 0, 7⟩

theorem sourceZ_ne_zero (P Q : Fin 3 → F) (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 ≠ Q 0 * P 2 ^ 2) (h2 : (2 : F) ≠ 0) :
    sourceZ P Q ≠ 0 := by
  rw [sourceZ_identity]
  exact mul_ne_zero (mul_ne_zero h2 (mul_ne_zero hPz hQz))
    (sub_ne_zero.mpr (Ne.symm hx))

theorem affine_X_ne (P Q : Fin 3 → F) (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 ≠ Q 0 * P 2 ^ 2) :
    P 0 / P 2 ^ 2 ≠ Q 0 / Q 2 ^ 2 := by
  intro heq
  apply hx
  exact (div_eq_div_iff (pow_ne_zero 2 hPz) (pow_ne_zero 2 hQz)).mp heq

theorem scaled_coordinates (P Q : Fin 3 → F) (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0) :
    u1 P Q / (P 2 * Q 2) ^ 2 = P 0 / P 2 ^ 2 ∧
    u2 P Q / (P 2 * Q 2) ^ 2 = Q 0 / Q 2 ^ 2 ∧
    s1 P Q / (P 2 * Q 2) ^ 3 = P 1 / P 2 ^ 3 ∧
    s2 P Q / (P 2 * Q 2) ^ 3 = Q 1 / Q 2 ^ 3 := by
  unfold u1 u2 s1 s2
  constructor
  · field_simp [hPz, hQz] <;> ring
  constructor
  · field_simp [hPz, hQz] <;> ring
  constructor <;> field_simp [hPz, hQz] <;> ring

theorem source_slope (P Q : Fin 3 → F) (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 ≠ Q 0 * P 2 ^ 2) :
    (s2 P Q - s1 P Q) / ((P 2 * Q 2) * h (u1 P Q) (u2 P Q)) =
      (curve F).toAffine.slope (P 0 / P 2 ^ 2) (Q 0 / Q 2 ^ 2)
        (P 1 / P 2 ^ 3) (Q 1 / Q 2 ^ 3) := by
  rw [WeierstrassCurve.Affine.slope_of_X_ne (affine_X_ne P Q hPz hQz hx)]
  have hh : h (u1 P Q) (u2 P Q) ≠ 0 := sub_ne_zero.mpr (Ne.symm hx)
  have hd : P 0 / P 2 ^ 2 - Q 0 / Q 2 ^ 2 ≠ 0 :=
    sub_ne_zero.mpr (affine_X_ne P Q hPz hQz hx)
  apply (div_eq_div_iff (mul_ne_zero (mul_ne_zero hPz hQz) hh) hd).2
  unfold s2 s1
  field_simp [hPz, hQz]
  unfold h u1 u2
  ring

theorem ordinary_add_mathlib (P Q : Fin 3 → F)
    (hP : (curve F).Equation P) (hQ : (curve F).Equation Q)
    (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 ≠ Q 0 * P 2 ^ 2) (h2 : (2 : F) ≠ 0) :
    sourceX P Q / sourceZ P Q ^ 2 =
      (curve F).addX P Q / WeierstrassCurve.Jacobian.addZ P Q ^ 2 ∧
    sourceY P Q / sourceZ P Q ^ 3 =
      (curve F).addY P Q / WeierstrassCurve.Jacobian.addZ P Q ^ 3 := by
  have hc := mul_ne_zero hPz hQz
  have hh : h (u1 P Q) (u2 P Q) ≠ 0 := sub_ne_zero.mpr (Ne.symm hx)
  have coords := scaled_coordinates P Q hPz hQz
  have slope := source_slope P Q hPz hQz hx
  constructor
  · rw [WeierstrassCurve.Jacobian.addX_of_Z_ne_zero hP hQ hPz hQz hx]
    unfold sourceX
    rw [sourceZ_identity, coreX_affine _ _ _ _ _ hc hh h2,
      slope, coords.1, coords.2.1]
    simp [curve, WeierstrassCurve.Affine.addX] <;> ring
  · rw [WeierstrassCurve.Jacobian.addY_of_Z_ne_zero hP hQ hPz hQz hx]
    unfold sourceY
    rw [sourceZ_identity, coreY_affine _ _ _ _ _ hc hh h2,
      coreX_affine _ _ _ _ _ hc hh h2, slope, coords.1, coords.2.1, coords.2.2.1]
    simp [curve, WeierstrassCurve.Affine.addY, WeierstrassCurve.Affine.negAddY,
      WeierstrassCurve.Affine.negY, WeierstrassCurve.Affine.addX] <;> ring

#print axioms sourceZ_ne_zero
#print axioms coreX_affine
#print axioms coreY_affine
#print axioms source_slope
#print axioms ordinary_add_mathlib

end FrostC07.Addition
