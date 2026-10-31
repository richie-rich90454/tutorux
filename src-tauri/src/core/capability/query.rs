use super::registry::CAPABILITIES;
use super::types::{Capability, Family, Port};

pub fn find(id: &str) -> Option<&'static Capability> {
    CAPABILITIES.iter().find(|capability| capability.id == id)
}

pub fn capabilities_for_port(port: Port) -> Vec<&'static Capability> {
    CAPABILITIES
        .iter()
        .filter(|capability| capability.ports.contains(&port))
        .collect()
}

pub fn counts_by_family() -> Vec<(Family, usize)> {
    let mut counts = std::collections::BTreeMap::<Family, usize>::new();
    for capability in CAPABILITIES {
        *counts.entry(capability.family).or_insert(0) += 1;
    }
    counts.into_iter().collect()
}
