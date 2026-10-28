import CoordinateFormulas
import AdditionFormulas

/-!
Partial C-07 field/group correspondence for add/double exceptional branches.
The source sentinel ![0,0,0] is interpreted as group zero by its Z=0 convention;
it is not asserted to be a nonsingular mathlib projective representative.
Finite inputs have explicit nonsingular (and hence on-curve) premises.
No uint256/EVM, canonical-residue, lift, hash, curve-order or verifier predicate
qualification is claimed. Source branch comparisons are equality in a field;
their correspondence with canonical modular uint256 operations remains open.
-/
namespace FrostC07.Exceptional

variable {F : Type} [Field F]

def infinity : Fin 3 → F := ![0, 0, 0]

noncomputable def interpret (P : Fin 3 → F) : (shortCurve F).toAffine.Point :=
  WeierstrassCurve.Jacobian.Point.toAffine (shortCurve F) P

def rawDouble (P : Fin 3 → F) : Fin 3 → F :=
  ![doubleX (P 0) (P 1), doubleY (P 0) (P 1), doubleZ (P 1) (P 2)]

noncomputable def sourceDouble (P : Fin 3 → F) : Fin 3 → F := by
  classical
  exact if P 2 = 0 ∨ P 1 = 0 then infinity else rawDouble P

noncomputable def sourceAdd (P Q : Fin 3 → F) : Fin 3 → F := by
  classical
  exact if P 2 = 0 then Q else if Q 2 = 0 then P else
    if Addition.u1 P Q = Addition.u2 P Q then
      if Addition.s1 P Q = Addition.s2 P Q then sourceDouble P else infinity
    else ![Addition.sourceX P Q, Addition.sourceY P Q, Addition.sourceZ P Q]

@[simp] theorem interpret_infinity : interpret (infinity : Fin 3 → F) = 0 :=
  WeierstrassCurve.Jacobian.Point.toAffine_of_Z_eq_zero rfl

theorem interpret_Z_zero (P : Fin 3 → F) (hz : P 2 = 0) : interpret P = 0 :=
  WeierstrassCurve.Jacobian.Point.toAffine_of_Z_eq_zero hz

/-- The unbranched source doubling polynomials equal mathlib's representative,
including the zero-Y polynomial case. Sentinel selection is proved separately. -/
theorem rawDouble_eq_mathlib (P : Fin 3 → F) :
    rawDouble P = (shortCurve F).dblXYZ P := by
  ext k
  fin_cases k <;>
    simp [rawDouble, WeierstrassCurve.Jacobian.dblXYZ,
      WeierstrassCurve.Jacobian.dblX, WeierstrassCurve.Jacobian.dblY,
      WeierstrassCurve.Jacobian.negDblY, WeierstrassCurve.Jacobian.dblZ,
      WeierstrassCurve.Jacobian.negY, WeierstrassCurve.Jacobian.dblU_eq,
      shortCurve, doubleX, doubleY, doubleD, doubleZ] <;> ring

theorem double_Z_zero (P : Fin 3 → F) (hz : P 2 = 0) : sourceDouble P = infinity := by
  simp [sourceDouble, hz]

theorem double_Y_zero (P : Fin 3 → F) (hy : P 1 = 0) : sourceDouble P = infinity := by
  simp [sourceDouble, hy]

theorem double_correct (P : Fin 3 → F)
    (hValid : P 2 = 0 ∨ (shortCurve F).Nonsingular P) :
    interpret (sourceDouble P) = interpret P + interpret P := by
  by_cases hz : P 2 = 0
  · rw [double_Z_zero P hz, interpret_infinity, interpret_Z_zero P hz]
    simp
  · have hP := hValid.resolve_left hz
    have group := WeierstrassCurve.Jacobian.Point.toAffine_add hP hP
    rw [WeierstrassCurve.Jacobian.add_self] at group
    by_cases hy : P 1 = 0
    · rw [double_Y_zero P hy, interpret_infinity]
      have hd : ((shortCurve F).dblXYZ P) 2 = 0 := by
        simp [WeierstrassCurve.Jacobian.dblXYZ, WeierstrassCurve.Jacobian.dblZ,
          WeierstrassCurve.Jacobian.negY, shortCurve, hy]
      have hi := WeierstrassCurve.Jacobian.Point.toAffine_of_Z_eq_zero
        (W := shortCurve F) hd
      exact hi.symm.trans group
    · simpa [sourceDouble, hz, hy, interpret, rawDouble_eq_mathlib] using group

theorem add_Z_zero_left (P Q : Fin 3 → F) (hz : P 2 = 0) :
    sourceAdd P Q = Q ∧ interpret (sourceAdd P Q) = interpret P + interpret Q := by
  constructor
  · simp [sourceAdd, hz]
  · simp [sourceAdd, hz, interpret_Z_zero P hz]

theorem add_Z_zero_right (P Q : Fin 3 → F) (hz : Q 2 = 0) :
    interpret (sourceAdd P Q) = interpret P + interpret Q := by
  by_cases hp : P 2 = 0
  · simp [sourceAdd, hp, hz, interpret_Z_zero P hp, interpret_Z_zero Q hz]
  · simp [sourceAdd, hp, hz, interpret_Z_zero Q hz]

theorem add_equal_XY (P Q : Fin 3 → F)
    (hP : (shortCurve F).Nonsingular P) (hQ : (shortCurve F).Nonsingular Q)
    (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 = Q 0 * P 2 ^ 2)
    (hy : P 1 * Q 2 ^ 3 = Q 1 * P 2 ^ 3) :
    sourceAdd P Q = sourceDouble P ∧
    interpret (sourceAdd P Q) = interpret P + interpret Q := by
  have branch : sourceAdd P Q = sourceDouble P := by
    simp [sourceAdd, Addition.u1, Addition.u2, Addition.s1, Addition.s2, hPz, hQz, hx, hy]
  have equiv := WeierstrassCurve.Jacobian.equiv_of_X_eq_of_Y_eq hPz hQz hx hy
  have same : interpret P = interpret Q :=
    WeierstrassCurve.Jacobian.Point.toAffine_of_equiv equiv
  exact ⟨branch, by rw [branch, double_correct P (Or.inr hP), ← same]⟩

/-- With valid finite points, equal projective X and unequal projective Y
is the inverse branch, by the existing mathlib curve addition theorem. -/
theorem add_equal_X_different_Y (P Q : Fin 3 → F)
    (hP : (shortCurve F).Nonsingular P) (hQ : (shortCurve F).Nonsingular Q)
    (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 = Q 0 * P 2 ^ 2)
    (hy : P 1 * Q 2 ^ 3 ≠ Q 1 * P 2 ^ 3) :
    sourceAdd P Q = infinity ∧
    interpret (sourceAdd P Q) = interpret P + interpret Q := by
  have branch : sourceAdd P Q = infinity := by
    simp [sourceAdd, Addition.u1, Addition.u2, Addition.s1, Addition.s2, hPz, hQz, hx, hy]
  have group := WeierstrassCurve.Jacobian.Point.toAffine_add hP hQ
  have hzOut : ((shortCurve F).add P Q) 2 = 0 := by
    rw [WeierstrassCurve.Jacobian.add_of_Y_ne hP.1 hQ.1 hPz hQz hx hy]
    change WeierstrassCurve.Jacobian.addU P Q * (0 : F) = 0
    exact mul_zero _
  have hi := WeierstrassCurve.Jacobian.Point.toAffine_of_Z_eq_zero (W := shortCurve F)
    hzOut
  exact ⟨branch, by rw [branch, interpret_infinity]; exact hi.symm.trans group⟩

theorem add_opposite_Y (P Q : Fin 3 → F)
    (hP : (shortCurve F).Nonsingular P) (hQ : (shortCurve F).Nonsingular Q)
    (hPz : P 2 ≠ 0) (hQz : Q 2 ≠ 0)
    (hx : P 0 * Q 2 ^ 2 = Q 0 * P 2 ^ 2)
    (hyOpp : P 1 * Q 2 ^ 3 = -(Q 1 * P 2 ^ 3)) (h2 : (2 : F) ≠ 0) :
    sourceAdd P Q = infinity ∧ interpret P + interpret Q = 0 := by
  by_cases hy : P 1 * Q 2 ^ 3 = Q 1 * P 2 ^ 3
  · have hneg : P 1 * Q 2 ^ 3 = -(P 1 * Q 2 ^ 3) := by
      calc
        P 1 * Q 2 ^ 3 = -(Q 1 * P 2 ^ 3) := hyOpp
        _ = -(P 1 * Q 2 ^ 3) := congrArg Neg.neg hy.symm
    have hyZero : P 1 = 0 := by
      by_contra hp
      exact ne_neg_of_two_ne_zero (P 1 * Q 2 ^ 3)
        (mul_ne_zero hp (pow_ne_zero 3 hQz)) h2 hneg
    have eq := add_equal_XY P Q hP hQ hPz hQz hx hy
    have branch : sourceAdd P Q = infinity := eq.1.trans (double_Y_zero P hyZero)
    exact ⟨branch, by rw [← eq.2, branch, interpret_infinity]⟩
  · have eq := add_equal_X_different_Y P Q hP hQ hPz hQz hx hy
    exact ⟨eq.1, by rw [← eq.2, eq.1, interpret_infinity]⟩

#print axioms rawDouble_eq_mathlib
#print axioms double_correct
#print axioms add_Z_zero_left
#print axioms add_Z_zero_right
#print axioms add_equal_XY
#print axioms add_equal_X_different_Y
#print axioms add_opposite_Y

end FrostC07.Exceptional
