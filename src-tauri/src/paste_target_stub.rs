#[derive(Clone, Default)]
pub struct PasteTarget;

pub fn capture_target() -> PasteTarget {
    PasteTarget::default()
}

pub fn paste_into_previous(_: &PasteTarget) {}
