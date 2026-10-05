//! Command and query registries: `name -> handler`, JSON in / JSON out.
//!
//! * **Commands** (`Game::command`) mutate the simulation: `Fn(&mut World, Args) -> Result<R, String>`.
//!   Names are namespaced `player.*`, `build.*`, `sys.*`, `world.*`, `debug.*`.
//! * **Queries** (`Game::query`) are read-only views for UI/HUD: `Fn(&World, Args) -> Result<R, String>`.
//!   The `&World` receiver makes mutation impossible. To read components use
//!   `world.try_query::<(&A, &B)>()` (returns `None` until the components exist) or look entities up
//!   through [`IdIndex`](crate::IdIndex) + `world.get::<T>(entity)`.
//!
//! `Args` is any `serde::Deserialize` type (use `#[serde(default)]` for optional fields; use
//! `serde_json::Value` to accept anything) and `R` any `Serialize` type. An empty / `null` JSON
//! argument string is treated as `{}`. The wire result is the serialised `R` (`()` -> `{}`), or
//! `{"error":"message"}` on failure; unknown names and malformed JSON also return an `error`.
//! Handlers run on the single sim thread between ticks; they must not block or loop unboundedly.

use bevy_ecs::prelude::{Resource, World};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;

type CommandFn = Box<dyn Fn(&mut World, Value) -> Result<String, String> + Send + Sync>;
type QueryFn = Box<dyn Fn(&World, Value) -> Result<String, String> + Send + Sync>;

/// Parses the JSON argument string passed from JS.
fn parse_args(json: &str) -> Result<Value, String> {
    let t = json.trim();
    if t.is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(t) {
        Ok(Value::Null) => Ok(json!({})),
        Ok(v) => Ok(v),
        Err(e) => Err(format!("invalid JSON arguments: {e}")),
    }
}

/// Final wire string: a handler result (already serialised) or `{"error":...}`; `()` -> `{}`.
/// Handlers serialise their typed result directly to a string so `f32` fields print in their
/// shortest round-trip form (`0.8`, not the widened `0.800000011920929` of `serde_json::Value`).
fn render(result: Result<String, String>) -> String {
    match result {
        Ok(s) if s == "null" => "{}".to_string(),
        Ok(s) => s,
        Err(e) => json!({ "error": e }).to_string(),
    }
}

fn error_json(msg: impl AsRef<str>) -> String {
    json!({ "error": msg.as_ref() }).to_string()
}

/// Registered commands (resource).
#[derive(Resource, Default)]
pub struct CommandRegistry {
    map: BTreeMap<&'static str, CommandFn>,
}

impl CommandRegistry {
    /// Registers a typed command. Panics on a duplicate name (build-time programmer error).
    pub fn register<A, R, F>(&mut self, name: &'static str, handler: F)
    where
        A: DeserializeOwned,
        R: Serialize,
        F: Fn(&mut World, A) -> Result<R, String> + Send + Sync + 'static,
    {
        let wrapped: CommandFn = Box::new(move |world, args| {
            let args: A = serde_json::from_value(args).map_err(|e| format!("bad arguments for '{name}': {e}"))?;
            let out = handler(world, args)?;
            serde_json::to_string(&out).map_err(|e| format!("cannot serialise result of '{name}': {e}"))
        });
        assert!(self.map.insert(name, wrapped).is_none(), "command '{name}' registered twice");
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.map.keys().copied().collect()
    }

    /// Executes `name` against `world`. Always returns a JSON string, never panics on bad input.
    pub fn call(world: &mut World, name: &str, json: &str) -> String {
        let args = match parse_args(json) {
            Ok(a) => a,
            Err(e) => return error_json(e),
        };
        // Take the registry out of the world so handlers can borrow the world mutably.
        let Some(reg) = world.remove_resource::<CommandRegistry>() else {
            return error_json("command registry missing");
        };
        let result = match reg.map.get(name) {
            Some(f) => render(f(world, args)),
            None => error_json(format!("unknown command '{name}'")),
        };
        world.insert_resource(reg);
        result
    }
}

/// Registered queries (resource).
#[derive(Resource, Default)]
pub struct QueryRegistry {
    map: BTreeMap<&'static str, QueryFn>,
}

impl QueryRegistry {
    /// Registers a typed query. Panics on a duplicate name (build-time programmer error).
    pub fn register<A, R, F>(&mut self, name: &'static str, handler: F)
    where
        A: DeserializeOwned,
        R: Serialize,
        F: Fn(&World, A) -> Result<R, String> + Send + Sync + 'static,
    {
        let wrapped: QueryFn = Box::new(move |world, args| {
            let args: A = serde_json::from_value(args).map_err(|e| format!("bad arguments for '{name}': {e}"))?;
            let out = handler(world, args)?;
            serde_json::to_string(&out).map_err(|e| format!("cannot serialise result of '{name}': {e}"))
        });
        assert!(self.map.insert(name, wrapped).is_none(), "query '{name}' registered twice");
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.map.keys().copied().collect()
    }

    /// Executes `name` against `world`. Always returns a JSON string, never panics on bad input.
    pub fn call(world: &World, name: &str, json: &str) -> String {
        let args = match parse_args(json) {
            Ok(a) => a,
            Err(e) => return error_json(e),
        };
        let Some(reg) = world.get_resource::<QueryRegistry>() else {
            return error_json("query registry missing");
        };
        match reg.map.get(name) {
            Some(f) => render(f(world, args)),
            None => error_json(format!("unknown query '{name}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Resource, Default)]
    struct Counter(i32);

    #[derive(Deserialize)]
    struct Add {
        #[serde(default)]
        n: i32,
    }

    fn world() -> World {
        let mut w = World::new();
        w.init_resource::<Counter>();
        let mut c = CommandRegistry::default();
        c.register("test.add", |w: &mut World, a: Add| {
            w.resource_mut::<Counter>().0 += a.n;
            Ok(json!({ "total": w.resource::<Counter>().0 }))
        });
        c.register("test.unit", |_: &mut World, _: Value| Ok::<(), String>(()));
        c.register("test.fail", |_: &mut World, _: Value| Err::<(), _>("nope".to_string()));
        w.insert_resource(c);
        let mut q = QueryRegistry::default();
        q.register("test.get", |w: &World, _: Value| Ok(json!({ "v": w.resource::<Counter>().0 })));
        w.insert_resource(q);
        w
    }

    #[test]
    fn commands_roundtrip() {
        let mut w = world();
        assert_eq!(CommandRegistry::call(&mut w, "test.add", r#"{"n":5}"#), r#"{"total":5}"#);
        assert_eq!(CommandRegistry::call(&mut w, "test.add", ""), r#"{"total":5}"#, "empty args = {{}} -> default");
        assert_eq!(CommandRegistry::call(&mut w, "test.unit", "null"), "{}");
        assert_eq!(QueryRegistry::call(&w, "test.get", ""), r#"{"v":5}"#);
    }

    #[test]
    fn errors_are_json_never_panics() {
        let mut w = world();
        assert_eq!(CommandRegistry::call(&mut w, "test.fail", ""), r#"{"error":"nope"}"#);
        let e = CommandRegistry::call(&mut w, "does.not.exist", "");
        assert!(e.contains("unknown command") && e.starts_with("{\"error\""), "{e}");
        let e = CommandRegistry::call(&mut w, "test.add", "{not json");
        assert!(e.contains("invalid JSON"), "{e}");
        let e = CommandRegistry::call(&mut w, "test.add", r#"{"n":"x"}"#);
        assert!(e.contains("bad arguments for 'test.add'"), "{e}");
        let e = QueryRegistry::call(&w, "nope", "");
        assert!(e.contains("unknown query"), "{e}");
        // registry survives all of that
        assert_eq!(CommandRegistry::call(&mut w, "test.add", r#"{"n":1}"#), r#"{"total":1}"#);
    }

    #[test]
    fn names_are_sorted() {
        let w = world();
        assert_eq!(w.resource::<CommandRegistry>().names(), vec!["test.add", "test.fail", "test.unit"]);
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_command_panics() {
        let mut c = CommandRegistry::default();
        c.register("a", |_: &mut World, _: Value| Ok::<(), String>(()));
        c.register("a", |_: &mut World, _: Value| Ok::<(), String>(()));
    }
}
