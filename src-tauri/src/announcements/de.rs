use serde::{
    de::{self, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use std::{fmt, marker::PhantomData};

pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

// Serde's derived structs also accept positional arrays. Require a map at every object boundary.
struct Object<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = Object<T>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }
        deserializer.deserialize_map(ObjectVisitor(PhantomData))
    }
}

pub(super) fn object<'de, D: Deserializer<'de>, T: Deserialize<'de>>(de: D) -> Result<T, D::Error> {
    Object::<T>::deserialize(de).map(|object| object.0)
}

pub(super) fn objects<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Vec<T>, D::Error> {
    Vec::<Object<T>>::deserialize(de)
        .map(|objects| objects.into_iter().map(|object| object.0).collect())
}

// Optional means absent, not JSON null. Defaults apply only when the field is missing.
pub(super) fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(de).map(Some)
}

pub(super) fn optional_object<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    object(de).map(Some)
}

pub(super) fn nullable_object<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    Option::<Object<T>>::deserialize(de).map(|object| object.map(|object| object.0))
}

// With deserialize_with and no default, the field must exist; explicit null is still valid.
pub(super) fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(de)
}

pub(super) fn unique_objects<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<std::collections::BTreeMap<String, T>, D::Error> {
    struct UniqueVisitor<T>(PhantomData<T>);
    impl<'de, T: Deserialize<'de>> Visitor<'de> for UniqueVisitor<T> {
        type Value = std::collections::BTreeMap<String, T>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a JSON object with unique keys and object values")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut values = std::collections::BTreeMap::new();
            while let Some((key, Object(value))) = map.next_entry::<String, Object<T>>()? {
                if values.insert(key, value).is_some() {
                    return Err(de::Error::custom("duplicate object key"));
                }
            }
            Ok(values)
        }
    }
    de.deserialize_map(UniqueVisitor(PhantomData))
}

pub(super) fn safe_integer<'de, D: Deserializer<'de>>(de: D) -> Result<u64, D::Error> {
    struct IntegerVisitor;
    impl<'de> Visitor<'de> for IntegerVisitor {
        type Value = u64;
        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a positive integer within JavaScript's safe integer range")
        }
        fn visit_u64<E: de::Error>(self, value: u64) -> Result<u64, E> {
            if (1..=MAX_SAFE_INTEGER).contains(&value) {
                Ok(value)
            } else {
                Err(E::custom("integer outside allowed range"))
            }
        }
        fn visit_i64<E: de::Error>(self, value: i64) -> Result<u64, E> {
            self.visit_u64(u64::try_from(value).map_err(|_| E::custom("negative integer"))?)
        }
        fn visit_f64<E: de::Error>(self, value: f64) -> Result<u64, E> {
            // JSON Schema considers 1.0 / 1e0 integers. This checked conversion is metadata only,
            // never scoring arithmetic; it mirrors Number/Ajv semantics within the safe range.
            if value.is_finite()
                && value >= 1.0
                && value <= MAX_SAFE_INTEGER as f64
                && value.fract() == 0.0
            {
                Ok(value as u64)
            } else {
                Err(E::custom("number is not a positive safe integer"))
            }
        }
    }
    de.deserialize_any(IntegerVisitor)
}
