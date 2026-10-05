//! # sim_build - placed blocks and furniture (wave 2; placeholder plugin)
//!
//! For now this only reserves the contract so the web side and the bridge can rely on it:
//! * channel `props` (`f32`, stride 12, static; `version` bumps whenever the set of placed props
//!   changes), registered **empty**,
//! * query `build.info`,
//! * save section `build` (the raw prop records).
//!
//! The build owner replaces the internals (snap grid, recipes, crafting, edit commands
//! `build.place` / `build.remove`) and defines the 12 columns of a prop record - see the
//! provisional layout in `docs/BRIDGE_API.md`.

use bevy_app::{App, Plugin};
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sim_core::{ChannelId, ChannelSpec, Channels, SimAppExt, SimPublish};

/// `f32` elements per prop record.
pub const PROP_STRIDE: usize = 12;
/// Maximum number of placed props the channel can hold.
pub const MAX_PROPS: usize = 8192;

/// All placed props as packed records ([`PROP_STRIDE`] floats each), in placement order.
#[derive(Resource, Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Props {
    pub records: Vec<f32>,
}

impl Props {
    /// Number of props.
    pub fn len(&self) -> usize {
        self.records.len() / PROP_STRIDE
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

/// Typed handle of the `props` channel.
#[derive(Resource, Clone, Copy)]
pub struct BuildChannels {
    pub props: ChannelId<f32>,
}

pub struct BuildPlugin;

impl Plugin for BuildPlugin {
    fn build(&self, app: &mut App) {
        let props = app.register_channel::<f32>(
            ChannelSpec::records::<f32>("props", PROP_STRIDE as u32, MAX_PROPS as u32)
                .doc("placed blocks / furniture, 12 floats per prop (static; version bumps on change)"),
        );
        app.insert_resource(BuildChannels { props }).init_resource::<Props>();
        app.add_systems(SimPublish, publish_props);

        app.register_query("build.info", |w: &World, _: Value| {
            let p = w.resource::<Props>();
            Ok(json!({ "props": p.len(), "stride": PROP_STRIDE, "max_props": MAX_PROPS }))
        });
        app.register_save_section(
            "build",
            1,
            |w: &World| w.resource::<Props>().clone(),
            |w: &mut World, p: Props| {
                if p.records.len() % PROP_STRIDE != 0 || p.records.len() > PROP_STRIDE * MAX_PROPS {
                    return Err("corrupt props record list".to_string());
                }
                if p.records.iter().any(|v| !v.is_finite()) {
                    return Err("non-finite value in props".to_string());
                }
                *w.resource_mut::<Props>() = p;
                Ok(())
            },
        );
    }
}

/// Copies the props into the channel when they changed and bumps `version`.
fn publish_props(props: Res<Props>, ids: Res<BuildChannels>, mut channels: ResMut<Channels>) {
    if !props.is_changed() {
        return;
    }
    channels.writer(ids.props).replace_with(&props.records);
    channels.bump_version(ids.props);
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Sim;

    fn sim() -> Sim {
        Sim::build(1, |app| {
            app.add_plugins(BuildPlugin);
        })
    }

    #[test]
    fn registers_an_empty_props_channel() {
        let s = sim();
        let info: Value = serde_json::from_str(&s.channel_info_json("props")).unwrap();
        assert_eq!((info["stride"].as_u64(), info["len"].as_u64(), info["kind"].as_str()), (Some(12), Some(0), Some("f32")));
        assert_eq!(info["prev_ptr"], 0, "props are static");
        assert_eq!(info["cap"], PROP_STRIDE * MAX_PROPS);
        let q: Value = serde_json::from_str(&s.query("build.info", "")).unwrap();
        assert_eq!(q["props"], 0);
    }

    #[test]
    fn props_are_published_with_a_version_bump_and_saved() {
        let mut s = sim();
        let v0: Value = serde_json::from_str(&s.channel_info_json("props")).unwrap();
        s.world_mut().resource_mut::<Props>().records.extend((0..PROP_STRIDE * 2).map(|i| i as f32));
        s.step_once();
        let info: Value = serde_json::from_str(&s.channel_info_json("props")).unwrap();
        assert_eq!(info["len"], PROP_STRIDE * 2);
        assert_eq!(info["version"].as_u64().unwrap(), v0["version"].as_u64().unwrap() + 1);
        s.step_once();
        let again: Value = serde_json::from_str(&s.channel_info_json("props")).unwrap();
        assert_eq!(again["version"], info["version"], "no republish without change");

        let file = sim_core::SaveFile::decode(&s.save().unwrap()).unwrap();
        let mut b = sim();
        b.apply_save(&file).unwrap();
        assert_eq!(b.world().resource::<Props>().len(), 2);
        let info: Value = serde_json::from_str(&b.channel_info_json("props")).unwrap();
        assert_eq!(info["len"], PROP_STRIDE * 2);
    }

    #[test]
    fn rejects_corrupt_prop_lists() {
        let mut s = sim();
        let bad = Props { records: vec![1.0; PROP_STRIDE + 1] };
        let mut file = sim_core::SaveFile::decode(&s.save().unwrap()).unwrap();
        let section = file.sections.iter_mut().find(|x| x.name == "build").unwrap();
        section.bytes = sim_core::save::encode(&bad).unwrap();
        assert!(s.apply_save(&file).is_err());
    }
}
